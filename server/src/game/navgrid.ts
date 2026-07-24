/**
 * The Crawling Dark — NPC nav grid + A* pathfinding (M4 · t4d, the optional
 * grid-A* fallback for the {@link ZombieAI}).
 *
 * Reactive steering (t4a) is cheap and flows nicely down the open street grid,
 * but it is a *local* method: it can only see one look-ahead ray fan, so a
 * building sitting squarely between the NPC and its prey — or a concave pocket
 * where two footprints nearly meet — traps it in a local minimum, grinding
 * against a wall with no candidate heading that makes progress. This module is
 * the *global* escape hatch: a coarse occupancy grid over the whole town and an
 * A* search across it, so the AI can plan a route around the obstacle and then
 * hand the existing steerer one waypoint at a time.
 *
 * Design choices:
 *   - **Server-only, non-deterministic.** Like the rest of {@link ZombieAI},
 *     only the authoritative server ever runs this; the grid is never networked,
 *     so it needn't match any client (and lives here in `server/`, not in
 *     `shared/`).
 *   - **Built once per world.** The town geometry is fixed for a round, so the
 *     blocked-cell bitmap is computed a single time in the constructor and
 *     reused for every search. A cell is walkable iff its centre clears every
 *     building footprint by {@link NAV_CLEARANCE} (the body radius plus a hair),
 *     so a path keeps the NPC's cylinder off the walls, and iff it sits inside
 *     the perimeter-wall clamp.
 *   - **8-connected, no corner cutting.** Diagonals are allowed only when both
 *     orthogonal neighbours are open, so a planned path never clips a building
 *     corner. Waypoints are the cell centres, collinear runs collapsed so a
 *     straight street is a single segment.
 */

import {
  MAP_SIZE,
  NAV_CELL_SIZE,
  NAV_CLEARANCE,
  type AABB,
  type World,
} from '@crawling-dark/shared';

/** A world-space waypoint on the XZ plane (a planned nav-grid cell centre). */
export interface Waypoint {
  x: number;
  z: number;
}

/** √2, the cost of a diagonal step relative to an orthogonal one. */
const SQRT2 = Math.SQRT2;

/**
 * The 8 grid neighbours as (dCol, dRow, cost). Orthogonals first (cost 1), then
 * diagonals (cost √2). Diagonals additionally require their two shared
 * orthogonal cells to be open (checked in {@link NavGrid.findPath}) so a path
 * never squeezes through a building corner.
 */
const NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

/**
 * How far (in cells) {@link NavGrid.findPath} will spiral outward to snap a
 * blocked start/goal onto the nearest walkable cell. Both endpoints are often
 * blocked in practice — a wedged NPC sits inside the inflated wall it's stuck
 * on, and prey frequently hugs a building — so snapping is the common case, not
 * an edge case. Bounded so a hopeless endpoint fails fast instead of scanning
 * the whole map.
 */
const SNAP_MAX_RADIUS = 8;

/**
 * A binary min-heap of cell indices keyed by their f-score, backing A*'s open
 * set. A tiny hand-rolled heap (rather than re-sorting an array) keeps each
 * pop/push at O(log n); the whole search stays well under a millisecond on this
 * map even when replanned several times a second.
 */
class MinHeap {
  // Each entry carries its own key (`keys[i]` for `ids[i]`), moved together on
  // every sift. A* re-pushes a cell whenever it finds a cheaper route, so the
  // heap holds duplicate ids at different keys; keeping the key IN the entry
  // (rather than in a shared per-id table) means one push never disturbs an
  // earlier entry's ordering. Stale duplicates are skipped by the closed set.
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  /** Push cell `id` with priority `key` (its f-score). */
  push(id: number, key: number): void {
    const { ids, keys } = this;
    ids.push(id);
    keys.push(key);
    let i = ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= keys[i]) break;
      [ids[parent], ids[i]] = [ids[i], ids[parent]];
      [keys[parent], keys[i]] = [keys[i], keys[parent]];
      i = parent;
    }
  }

  /** Pop the lowest-key cell id (assumes non-empty). */
  pop(): number {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop() as number;
    const lastKey = keys.pop() as number;
    if (ids.length > 0) {
      ids[0] = lastId;
      keys[0] = lastKey;
      let i = 0;
      const n = ids.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && keys[l] < keys[smallest]) smallest = l;
        if (r < n && keys[r] < keys[smallest]) smallest = r;
        if (smallest === i) break;
        [ids[smallest], ids[i]] = [ids[i], ids[smallest]];
        [keys[smallest], keys[i]] = [keys[i], keys[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Squared distance from point (x, z) to the closest point on `aabb` (0 inside). */
function distSqToAABB(x: number, z: number, aabb: AABB): number {
  const dx = x < aabb.minX ? aabb.minX - x : x > aabb.maxX ? x - aabb.maxX : 0;
  const dz = z < aabb.minZ ? aabb.minZ - z : z > aabb.maxZ ? z - aabb.maxZ : 0;
  return dx * dx + dz * dz;
}

/**
 * A coarse occupancy grid over the whole town plus an A* search across it. Built
 * once from a {@link World}; queried by {@link ZombieAI} only when reactive
 * steering stalls.
 */
export class NavGrid {
  /** Cells per axis (square grid). */
  readonly cols: number;
  readonly rows: number;
  /** Cell edge length in meters. */
  readonly cell: number;
  /** World coordinate of the grid's minimum corner on both axes (−half). */
  private readonly origin: number;
  /** Walkability bitmap, row-major (`row * cols + col`); 1 = blocked. */
  private readonly blocked: Uint8Array;

  constructor(world: World, clearance = NAV_CLEARANCE) {
    this.cell = NAV_CELL_SIZE;
    this.origin = -world.half;
    const n = Math.ceil(MAP_SIZE / this.cell);
    this.cols = n;
    this.rows = n;
    this.blocked = new Uint8Array(n * n);

    // A cell is walkable iff its centre sits inside the perimeter-wall clamp and
    // clears every building footprint by `clearance`. Precomputed once — the town
    // never changes within a round.
    const wallLimit = world.half - world.wallThickness - clearance;
    const clearSq = clearance * clearance;
    for (let row = 0; row < n; row++) {
      const wz = this.centerOf(row);
      for (let col = 0; col < n; col++) {
        const wx = this.centerOf(col);
        let solid = Math.abs(wx) > wallLimit || Math.abs(wz) > wallLimit;
        if (!solid) {
          for (let i = 0; i < world.colliders.length; i++) {
            if (distSqToAABB(wx, wz, world.colliders[i]) < clearSq) {
              solid = true;
              break;
            }
          }
        }
        if (solid) this.blocked[row * n + col] = 1;
      }
    }
  }

  /** World coordinate of the centre of grid line `i` (a col on X or row on Z). */
  private centerOf(i: number): number {
    return this.origin + (i + 0.5) * this.cell;
  }

  /** Grid col/row containing world coordinate `w`, clamped to the grid. */
  private lineOf(w: number): number {
    const i = Math.floor((w - this.origin) / this.cell);
    return i < 0 ? 0 : i >= this.cols ? this.cols - 1 : i;
  }

  private inBounds(col: number, row: number): boolean {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  /** Whether the cell (col, row) is walkable (in bounds and not blocked). */
  isOpen(col: number, row: number): boolean {
    return this.inBounds(col, row) && this.blocked[row * this.cols + col] === 0;
  }

  /**
   * Nearest walkable cell to (col, row) within {@link SNAP_MAX_RADIUS}, searched
   * by growing Chebyshev rings so the closest open cell wins. Returns the packed
   * index `row * cols + col`, or −1 if everything nearby is solid. Lets A* plan
   * from/to endpoints that themselves sit inside an inflated wall (a wedged NPC,
   * or prey pressed against a building).
   */
  private snapToOpen(col: number, row: number): number {
    if (this.isOpen(col, row)) return row * this.cols + col;
    for (let r = 1; r <= SNAP_MAX_RADIUS; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          // Only the ring at Chebyshev radius exactly r (its perimeter).
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const c = col + dx;
          const rr = row + dz;
          if (this.isOpen(c, rr)) return rr * this.cols + c;
        }
      }
    }
    return -1;
  }

  /**
   * A* from world point (sx, sz) to (tx, tz) across the nav grid. Returns the
   * route as world-space {@link Waypoint}s — collinear cells collapsed and the
   * start cell dropped, so the list is the corners to steer through *after* the
   * NPC's current position. Returns `null` if either endpoint has no walkable
   * cell within snapping range, if no path exists, or if the whole route
   * collapses to nothing (already at the goal cell) — in every case the caller
   * simply keeps steering directly.
   *
   * 8-connected with the octile heuristic (admissible for this step set, so the
   * path is optimal); diagonals never cut a building corner.
   */
  findPath(sx: number, sz: number, tx: number, tz: number): Waypoint[] | null {
    const cols = this.cols;
    const start = this.snapToOpen(this.lineOf(sx), this.lineOf(sz));
    const goal = this.snapToOpen(this.lineOf(tx), this.lineOf(tz));
    if (start < 0 || goal < 0) return null;
    if (start === goal) return null; // already in the goal cell — just steer.

    const total = cols * this.rows;
    const gScore = new Float64Array(total).fill(Infinity);
    const cameFrom = new Int32Array(total).fill(-1);
    const closed = new Uint8Array(total);
    const open = new MinHeap();

    const goalCol = goal % cols;
    const goalRow = (goal / cols) | 0;
    const heuristic = (col: number, row: number): number => {
      const dx = Math.abs(col - goalCol);
      const dz = Math.abs(row - goalRow);
      const dmin = Math.min(dx, dz);
      const dmax = Math.max(dx, dz);
      return dmax - dmin + SQRT2 * dmin; // octile distance
    };

    gScore[start] = 0;
    open.push(start, heuristic(start % cols, (start / cols) | 0));

    while (open.size > 0) {
      const current = open.pop();
      if (current === goal) return this.reconstruct(cameFrom, current);
      if (closed[current]) continue;
      closed[current] = 1;

      const col = current % cols;
      const row = (current / cols) | 0;
      const g = gScore[current];

      for (const [dc, dr, cost] of NEIGHBORS) {
        const nc = col + dc;
        const nr = row + dr;
        if (!this.isOpen(nc, nr)) continue;
        // No corner cutting: a diagonal move needs both shared orthogonals open.
        if (dc !== 0 && dr !== 0) {
          if (!this.isOpen(col + dc, row) || !this.isOpen(col, row + dr)) continue;
        }
        const ni = nr * cols + nc;
        if (closed[ni]) continue;
        const tentative = g + cost;
        if (tentative < gScore[ni]) {
          gScore[ni] = tentative;
          cameFrom[ni] = current;
          open.push(ni, tentative + heuristic(nc, nr));
        }
      }
    }
    return null; // goal unreachable from start
  }

  /**
   * Walk `cameFrom` back from the goal to the start, then emit world-space
   * waypoints from start→goal with collinear runs collapsed (only the cells
   * where the step direction changes survive) and the start cell itself dropped.
   */
  private reconstruct(cameFrom: Int32Array, goal: number): Waypoint[] | null {
    const cols = this.cols;
    const cells: number[] = [];
    for (let c = goal; c !== -1; c = cameFrom[c]) cells.push(c);
    cells.reverse(); // start .. goal

    const out: Waypoint[] = [];
    let prevDc = NaN;
    let prevDr = NaN;
    for (let i = 1; i < cells.length; i++) {
      const prev = cells[i - 1];
      const cur = cells[i];
      const dc = Math.sign((cur % cols) - (prev % cols));
      const dr = Math.sign(((cur / cols) | 0) - ((prev / cols) | 0));
      // Emit the *previous* cell as a corner whenever the heading turns.
      if (i > 1 && (dc !== prevDc || dr !== prevDr)) {
        out.push({ x: this.centerOf(prev % cols), z: this.centerOf((prev / cols) | 0) });
      }
      prevDc = dc;
      prevDr = dr;
    }
    // Always include the goal cell centre as the final waypoint.
    const last = cells[cells.length - 1];
    out.push({ x: this.centerOf(last % cols), z: this.centerOf((last / cols) | 0) });
    return out.length > 0 ? out : null;
  }
}
