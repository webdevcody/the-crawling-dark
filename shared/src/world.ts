/**
 * The Crawling Dark — seeded town geometry & 2.5D collision (M2 · t2a, extended
 * for the natural/urban world in M9 · t9a).
 *
 * The "town" is a bounded grid of building boxes arranged around streets, with
 * a clear central plaza and a perimeter wall so no one runs off the map. Since
 * M9 the same seed also produces natural/urban features — a scatter of solid
 * **trees**, one **lake**, and a decorative **road** grid — so the world reads
 * as a real place. It is generated **purely from a single integer seed**, which
 * is the whole point: the authoritative server and every client run
 * {@link generateWorld} with the same `mapSeed` (see the WELCOME message in the
 * protocol) and end up with byte-for-byte identical geometry — same building
 * list, same tree/lake/road data, same colliders. The client renders the world;
 * the server collides players against the very same footprints. Because of that
 * shared-source-of-truth guarantee, this module must be *fully deterministic*:
 * it NEVER calls `Math.random`; all variation comes from the inline
 * {@link mulberry32} PRNG.
 *
 * Collision model (see docs/DESIGN.md §4 "World & collision"): players are
 * cylinders on a flat ground plane, so collision is resolved as a 2.5D problem
 * on the **XZ plane** — **circle-vs-AABB** for buildings and **circle-vs-circle**
 * for trees (and the lake shoreline, when water is `blocked`). Y (jump/gravity)
 * is handled elsewhere in `sim.ts`. This avoids a full 3D physics engine while
 * still feeling solid, and lets us later swap the box meshes for GLTF town assets
 * without touching collision — collision only ever reads the collider lists.
 *
 * All units are meters. World-space X and Z span [-MAP_SIZE/2, +MAP_SIZE/2].
 */

import { MAP_SIZE } from './constants';

/* -------------------------------------------------------------------------- */
/* Public data shapes                                                         */
/* -------------------------------------------------------------------------- */

/** Axis-aligned bounding box footprint on the XZ plane (Y is handled separately). */
export interface AABB {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** One town building: an XZ box (center + half-extents) with a render height on Y. */
export interface Building {
  id: number;
  cx: number; // center on X (meters)
  cz: number; // center on Z (meters)
  hw: number; // half-width on X (meters)
  hd: number; // half-depth on Z (meters)
  height: number; // render height on Y (meters)
}

/**
 * One tree: a **circular** XZ collider (a solid trunk/low-canopy footprint) with
 * a render height on Y. Trees are resolved as circle-vs-circle in
 * {@link collideCircleXZ}; unlike buildings they are kept OUT of `colliders`
 * (which is AABB-typed and read by the nav grid / ray casts) so those consumers
 * are untouched until M9 · t9f wires trees into AI perception.
 */
export interface Tree {
  id: number;
  x: number; // center on X (meters)
  z: number; // center on Z (meters)
  radius: number; // collision + trunk radius on the XZ plane (meters)
  height: number; // render height on Y (meters)
}

/**
 * How a player interacts with open water. `'blocked'` (the rule chosen for M9)
 * makes the lake a solid circular shoreline the body is pushed out of, exactly
 * like a tree; `'slow'` would instead leave the water walkable and apply a
 * movement penalty in the sim (left as a seam for a later pass — it is not
 * resolved by {@link collideCircleXZ}).
 */
export type WaterMode = 'blocked' | 'slow';

/** A lake: a circular water region on the XZ plane (center + radius, meters). */
export interface Lake {
  cx: number;
  cz: number;
  radius: number;
}

/** A point on the XZ plane used by {@link Road} polylines. */
export interface RoadPoint {
  x: number;
  z: number;
}

/**
 * One decorative road: a polyline (2+ points) with a render `width`. Roads are
 * **non-colliding** — they exist for rendering (M9 · t9e) and to anchor the
 * street layout (refined in M9 · t9b) — and are intentionally NOT added to
 * `colliders`.
 */
export interface Road {
  points: RoadPoint[];
  width: number;
}

/** The fully-resolved, deterministic town. */
export interface World {
  seed: number;
  size: number; // == MAP_SIZE (full square edge length)
  half: number; // == MAP_SIZE / 2 (perimeter half-extent)
  wallThickness: number; // perimeter wall thickness (meters)
  buildings: Building[];
  /** Every solid AABB collision footprint (building footprints; NOT the perimeter — perimeter is a clamp). */
  colliders: AABB[];
  /** Solid circular tree colliders (see {@link Tree}); resolved in {@link collideCircleXZ}. */
  trees: Tree[];
  /** The single lake, or `null` if this seed has none. Collision depends on {@link waterMode}. */
  water: Lake | null;
  /** The world's water interaction rule (see {@link WaterMode}). */
  waterMode: WaterMode;
  /** Decorative, non-colliding road polylines (see {@link Road}). */
  roads: Road[];
}

/* -------------------------------------------------------------------------- */
/* Layout tunables (local to town generation)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Perimeter wall thickness in meters. The wall is not a push-out collider — it
 * is enforced as a hard clamp in {@link collideCircleXZ} — but we still emit it
 * as render boxes so the client can draw the town's edge.
 */
const WALL_THICKNESS = 1.0;

/** Wall render height in meters (walls are drawn as thin, tallish boxes). */
const WALL_HEIGHT = 3.0;

/**
 * Radius (meters) of the guaranteed building-free plaza around the origin. The
 * server spawns players on a ring of radius ~4 m here, so this MUST comfortably
 * exceed that; the design floor is 10 m and we keep a little extra headroom.
 * Any candidate building whose footprint would reach inside this circle is
 * dropped, which is what keeps spawns from ever landing inside a wall.
 */
const PLAZA_RADIUS = 12.0;

/** Number of city blocks along each axis (N_BLOCKS × N_BLOCKS cells → ≤36 buildings). */
const N_BLOCKS = 6;

/**
 * Half-extent (meters) of the region the buildings occupy. The remaining band
 * between this and the perimeter half (MAP_SIZE/2) is a wide "ring road" street
 * that keeps buildings well clear of the wall.
 */
const TOWN_HALF = 54.0;

/** Half of a street's width (meters). Each building keeps at least this much clearance to its cell edge, so neighbouring buildings sit ≥ STREET_HALF*2 apart. */
const STREET_HALF = 3.0;

/** Building footprint half-extents are randomized within this closed range (meters). */
const MIN_HALF_EXTENT = 2.5;
const MAX_HALF_EXTENT = 5.5;

/* --- M9 · t9b: district building profile (small houses → skyscrapers) ----- */

/**
 * The town reads as a real city by grading building height + footprint with a
 * block's distance from the core (t9b). A block's "district" is a 0→1 factor of
 * `max(|cx|,|cz|)` (its Chebyshev distance to the origin): 0 at/inside
 * {@link DISTRICT_CORE_EDGE} (downtown), 1 at/outside {@link DISTRICT_RIM_EDGE}
 * (outskirts). For the 6×6 grid, surviving block centres sit at `|center|` ∈
 * {27, 45} (the innermost `|center| = 9` ring always falls inside the plaza and
 * is dropped), so these edges split the map cleanly into a **tower core** at 27
 * and a **house rim** at 45.
 */
const DISTRICT_CORE_EDGE = 27.0;
const DISTRICT_RIM_EDGE = 45.0;

/** Core (downtown) building height range — tall towers (meters). */
const CORE_MIN_HEIGHT = 16.0;
const CORE_MAX_HEIGHT = 44.0;

/** Rim (outskirts) building height range — small houses (meters). */
const RIM_MIN_HEIGHT = 3.5;
const RIM_MAX_HEIGHT = 8.0;

/**
 * Footprint scale by district: rim houses are smaller than core towers. Always
 * ≤ 1, so a scaled footprint can only shrink — it never breaches the per-cell
 * street-clearance bound that keeps buildings out of the streets.
 */
const CORE_FOOT_SCALE = 1.0;
const RIM_FOOT_SCALE = 0.6;

/* --- M9 · t9a/t9d: lake tunables (t9d widens it a touch for presence) ------ */

/**
 * The world's water interaction rule. M9 picks `'blocked'`: the lake is a solid
 * shoreline you cannot cross (see {@link WaterMode}). Encoded once here and
 * carried on the {@link World} so the client and AI can read the same choice.
 */
const WATER_MODE: WaterMode = 'blocked';

/** Lake radius range (meters). */
const MIN_LAKE_RADIUS = 8.0;
const MAX_LAKE_RADIUS = 12.0;

/**
 * The lake center is placed on a ring this far (meters) from the origin. The
 * bounds guarantee the whole disc clears the {@link PLAZA_RADIUS} plaza on the
 * inside (ring−radius ≥ 16 > 12) and stays well inside {@link TOWN_HALF} on the
 * outside (ring+radius ≤ 50 < 54), so it neither reaches the spawn plaza nor the
 * perimeter forest band, and the road grid still routes around it.
 */
const LAKE_RING_MIN = 28.0;
const LAKE_RING_MAX = 38.0;

/* --- M9 · t9c: dense perimeter forest ------------------------------------- */

/** Tree collision/trunk radius range (meters). */
const MIN_TREE_RADIUS = 0.75;
const MAX_TREE_RADIUS = 1.05;

/** Tree render height range (meters). */
const MIN_TREE_HEIGHT = 5.0;
const MAX_TREE_HEIGHT = 11.0;

/**
 * Dense perimeter forest (t9c). Instead of the sparse boundary rings t9a shipped,
 * a thick band of solid trees fills the square annulus from just OUTSIDE the ring
 * road out to the wall clamp, so the map edge reads as a wall of forest and is
 * walk-through-proof — the perimeter clamp stays as an invisible backstop hidden
 * behind the trees. Trees are packed on a fixed grid (spacing {@link FOREST_STEP},
 * per-tree {@link FOREST_JITTER}) over the band; at this spacing and trunk radius
 * the surface gap between neighbours stays under a player's diameter even at the
 * worst jitter, and the band is several rows deep, so no straight path threads it.
 */
const FOREST_BAND_INNER = TOWN_HALF + 4.0; // ~58 m — just past the ring road's outer edge
const FOREST_STEP = 1.4; // candidate grid spacing (m); tight enough to be impassable
const FOREST_JITTER = 0.35; // per-tree positional jitter (± m) so it isn't a bare lattice
/** Keep the forest this far (meters) clear of the lake shoreline. */
const TREE_CLEARANCE = 0.75;

/**
 * Distance (meters) the NPC "patient zero" spawns inside each map corner — it is
 * placed at `(half − NPC_SPAWN_INSET, half − NPC_SPAWN_INSET)` by the server (see
 * `Room.spawnNpcZombie`). Mirrored here so the forest can leave that corner clear.
 */
const NPC_SPAWN_INSET = 5.0;

/**
 * Radius (meters) of the clearing kept free of forest around the NPC spawn corner,
 * so the zombie never wakes wedged inside the tree wall (the wall clamp still
 * contains it there). Comfortably larger than {@link NPC_SPAWN_INSET}'s slack.
 */
const NPC_SPAWN_CLEARING = 7.5;

/* -------------------------------------------------------------------------- */
/* Deterministic PRNG                                                         */
/* -------------------------------------------------------------------------- */

/**
 * mulberry32 — a tiny, fast, fully-deterministic 32-bit PRNG. Given the same
 * seed it always yields the same stream of floats in [0, 1), which is exactly
 * what lets the client and server agree on the town without exchanging it.
 *
 * We keep this inline (rather than pulling a dependency) so the behaviour can
 * never drift between packages. Do NOT replace with `Math.random`.
 *
 * @param seed 32-bit integer seed.
 * @returns A function returning the next float in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clamp `v` into the inclusive range [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Footprint AABB derived from a building. */
export function buildingAABB(b: Building): AABB {
  return {
    minX: b.cx - b.hw,
    maxX: b.cx + b.hw,
    minZ: b.cz - b.hd,
    maxZ: b.cz + b.hd,
  };
}

/**
 * Squared distance from point (x, z) to the closest point on `aabb` (0 when the
 * point is inside). Used to test plaza/lake clearance without a `sqrt`.
 */
function distSqToAABB(x: number, z: number, aabb: AABB): number {
  const dx = x < aabb.minX ? aabb.minX - x : x > aabb.maxX ? x - aabb.maxX : 0;
  const dz = z < aabb.minZ ? aabb.minZ - z : z > aabb.maxZ ? z - aabb.maxZ : 0;
  return dx * dx + dz * dz;
}

/* -------------------------------------------------------------------------- */
/* Town generation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Deterministically place the single lake. Its radius, the ring distance from
 * origin, and its bearing are all drawn from `rng`; the bounds on those (see
 * {@link LAKE_RING_MIN}/{@link LAKE_RING_MAX}/{@link MAX_LAKE_RADIUS}) keep the
 * whole disc clear of the plaza and inside the town, and a final clamp is a
 * belt-and-braces guard. Consumes exactly 3 PRNG values.
 */
function generateLake(rng: () => number): Lake {
  const radius = MIN_LAKE_RADIUS + rng() * (MAX_LAKE_RADIUS - MIN_LAKE_RADIUS);
  const ring = LAKE_RING_MIN + rng() * (LAKE_RING_MAX - LAKE_RING_MIN);
  const angle = rng() * Math.PI * 2;
  const bound = TOWN_HALF - radius - 1;
  const cx = clamp(Math.cos(angle) * ring, -bound, bound);
  const cz = clamp(Math.sin(angle) * ring, -bound, bound);
  return { cx, cz, radius };
}

/**
 * Emit the decorative street network (t9b): one lane along each *interior* block
 * boundary on both axes, plus a **ring road** — a closed loop tracing the town's
 * outer boundary at ±TOWN_HALF that ties every interior lane's ends together and
 * fronts the perimeter forest. Purely structural, so fully deterministic without
 * touching the PRNG. Non-colliding (render/layout data only).
 */
function generateRoads(): Road[] {
  const roads: Road[] = [];
  const cellSize = (2 * TOWN_HALF) / N_BLOCKS;
  const width = STREET_HALF * 2;
  for (let k = 1; k < N_BLOCKS; k++) {
    const c = -TOWN_HALF + cellSize * k;
    // Vertical lane (constant X) and horizontal lane (constant Z).
    roads.push({ points: [{ x: c, z: -TOWN_HALF }, { x: c, z: TOWN_HALF }], width });
    roads.push({ points: [{ x: -TOWN_HALF, z: c }, { x: TOWN_HALF, z: c }], width });
  }
  // Ring road: one closed loop around the town boundary connecting the lanes.
  const r = TOWN_HALF;
  roads.push({
    points: [
      { x: -r, z: -r },
      { x: r, z: -r },
      { x: r, z: r },
      { x: -r, z: r },
      { x: -r, z: -r },
    ],
    width,
  });
  return roads;
}

/**
 * Deterministically pack the dense perimeter forest (t9c): a thick band of solid
 * trees filling the square annulus between {@link FOREST_BAND_INNER} and the wall
 * clamp, so the map edge is a walk-through-proof wall of forest rather than a bare
 * slab (the perimeter clamp survives as an invisible backstop behind the trees).
 *
 * Candidates are stepped on a fixed {@link FOREST_STEP} grid over the bounding
 * square; each draws four PRNG values (x/z jitter, trunk radius, height) — ALWAYS
 * consumed, even when the candidate is later rejected, so the stream stays aligned
 * regardless of where the lake landed. A candidate is kept only when its
 * (jittered) centre lands in the band on `max(|x|,|z|)` (Chebyshev distance, so
 * the band hugs the *square* edge uniformly, corners included), outside the NPC
 * spawn clearing, and clear of the lake. At this spacing/radius the neighbour
 * surface gap stays under a player's diameter and the band is several rows deep,
 * so no straight path threads it.
 */
function generateTrees(rng: () => number, water: Lake | null): Tree[] {
  const trees: Tree[] = [];
  let id = 0;
  const wallLimit = MAP_SIZE / 2 - WALL_THICKNESS - MAX_TREE_RADIUS - 0.5;
  // Keep the NPC "patient zero" spawn corner (half − inset on both axes) clear.
  const npcX = MAP_SIZE / 2 - NPC_SPAWN_INSET;
  const npcZ = npcX;
  const clearingSq = NPC_SPAWN_CLEARING * NPC_SPAWN_CLEARING;

  const start = -wallLimit;
  const steps = Math.floor((2 * wallLimit) / FOREST_STEP);
  for (let gi = 0; gi <= steps; gi++) {
    const baseX = start + gi * FOREST_STEP;
    for (let gj = 0; gj <= steps; gj++) {
      const baseZ = start + gj * FOREST_STEP;
      // Draw all four values up front so the PRNG stream never depends on which
      // candidates are rejected below (keeps the forest identical per seed).
      const x = baseX + (rng() * 2 - 1) * FOREST_JITTER;
      const z = baseZ + (rng() * 2 - 1) * FOREST_JITTER;
      const radius = MIN_TREE_RADIUS + rng() * (MAX_TREE_RADIUS - MIN_TREE_RADIUS);
      const height = MIN_TREE_HEIGHT + rng() * (MAX_TREE_HEIGHT - MIN_TREE_HEIGHT);

      // Square annulus: keep only the band just past the ring road, out to the
      // wall clamp (so a tree can never be pushed into / past the wall).
      const cheb = Math.abs(x) > Math.abs(z) ? Math.abs(x) : Math.abs(z);
      if (cheb < FOREST_BAND_INNER || cheb > wallLimit) continue;

      // Leave the NPC spawn corner an open clearing.
      const ndx = x - npcX;
      const ndz = z - npcZ;
      if (ndx * ndx + ndz * ndz < clearingSq) continue;

      // Never grow a tree in the water (the lake never reaches this band with the
      // current tunables, but keep the guard robust to future lake tweaks).
      if (water !== null) {
        const dx = x - water.cx;
        const dz = z - water.cz;
        const keep = water.radius + radius + TREE_CLEARANCE;
        if (dx * dx + dz * dz < keep * keep) continue;
      }

      trees.push({ id: id++, x, z, radius, height });
    }
  }
  return trees;
}

/**
 * Deterministically build the whole world from a single integer seed. Same seed
 * => identical geometry (identical `buildings`, `colliders`, `trees`, `water`,
 * and `roads`).
 *
 * Layout: a `N_BLOCKS × N_BLOCKS` grid of city blocks spans the region
 * [-TOWN_HALF, +TOWN_HALF] on X and Z. Each block holds at most one building,
 * with its footprint and height jittered by the PRNG for character but always
 * kept inside the block's inner area (leaving STREET_HALF clearance to every
 * cell edge) — so buildings never overlap each other and never spill into the
 * streets between them. Footprint + height are additionally graded by district
 * (M9 · t9b): tall towers cluster in the core, small houses ring the rim. Any
 * candidate whose footprint would reach inside the central {@link PLAZA_RADIUS}
 * plaza, or into the {@link generateLake lake}, is dropped, keeping the spawn
 * area clear and no building standing in the water.
 *
 * Natural/urban features (M9) are drawn from a SEPARATE, seed-derived PRNG stream
 * (`seed ^ 0x9e3779b9`) so the lake/forest never perturb the building PRNG: the
 * per-seed building *placement* stream stays aligned, and only the deliberate t9b
 * district re-profiling (and the drop of any building now under the lake) changes
 * the resulting boxes.
 *
 * The four perimeter walls are emitted as thin render `Building` boxes so the
 * client can draw the map edge, but they are intentionally left OUT of
 * `colliders`: the wall is enforced as a position clamp in
 * {@link collideCircleXZ}, and adding it as push-out boxes too would
 * double-resolve against that clamp.
 */
export function generateWorld(seed: number): World {
  const rng = mulberry32(seed);
  // Independent stream for the natural/urban features, so buildings are unchanged.
  const featureRng = mulberry32((seed ^ 0x9e3779b9) >>> 0);

  const half = MAP_SIZE / 2;
  const cellSize = (2 * TOWN_HALF) / N_BLOCKS;
  // Half-width of the area within a cell a building may occupy. Keeping every
  // footprint inside this bound guarantees ≥ STREET_HALF clearance to the cell
  // edge, hence ≥ 2*STREET_HALF between any two neighbouring buildings.
  const innerHalf = cellSize / 2 - STREET_HALF;

  // Place the lake first so buildings can be dropped where it sits.
  const water = generateLake(featureRng);
  const lakeKeepSq = (water.radius + 0.5) * (water.radius + 0.5);

  const buildings: Building[] = [];
  const colliders: AABB[] = [];
  let nextId = 0;

  for (let ix = 0; ix < N_BLOCKS; ix++) {
    for (let iz = 0; iz < N_BLOCKS; iz++) {
      const cellCenterX = -TOWN_HALF + cellSize * (ix + 0.5);
      const cellCenterZ = -TOWN_HALF + cellSize * (iz + 0.5);

      // District gradient (t9b): grade footprint + height by how far the block
      // sits from the core — tall towers downtown, small houses on the rim. The
      // factor is 0 at/inside the core edge, 1 at/outside the rim edge.
      const distAbs =
        Math.abs(cellCenterX) > Math.abs(cellCenterZ)
          ? Math.abs(cellCenterX)
          : Math.abs(cellCenterZ);
      const districtT = clamp(
        (distAbs - DISTRICT_CORE_EDGE) / (DISTRICT_RIM_EDGE - DISTRICT_CORE_EDGE),
        0,
        1,
      );
      const footScale = CORE_FOOT_SCALE + (RIM_FOOT_SCALE - CORE_FOOT_SCALE) * districtT;
      const minHeight = CORE_MIN_HEIGHT + (RIM_MIN_HEIGHT - CORE_MIN_HEIGHT) * districtT;
      const maxHeight = CORE_MAX_HEIGHT + (RIM_MAX_HEIGHT - CORE_MAX_HEIGHT) * districtT;

      // Draw the footprint & height. We always consume the same number of PRNG
      // values per cell (even when the building is later dropped) so the stream
      // stays aligned and the whole town stays deterministic. `footScale` (≤ 1)
      // only shrinks a footprint, so the street-clearance bound still holds.
      const hw = (MIN_HALF_EXTENT + rng() * (MAX_HALF_EXTENT - MIN_HALF_EXTENT)) * footScale;
      const hd = (MIN_HALF_EXTENT + rng() * (MAX_HALF_EXTENT - MIN_HALF_EXTENT)) * footScale;
      // Jitter the center, but never enough to breach the cell's inner area.
      const maxOffX = innerHalf - hw;
      const maxOffZ = innerHalf - hd;
      const cx = cellCenterX + (rng() * 2 - 1) * maxOffX;
      const cz = cellCenterZ + (rng() * 2 - 1) * maxOffZ;
      const height = minHeight + rng() * (maxHeight - minHeight);

      const candidate: Building = { id: nextId, cx, cz, hw, hd, height };
      const aabb = buildingAABB(candidate);

      // Keep the central plaza clear: skip any building whose footprint reaches
      // inside the plaza circle. This is what makes the spawn ring safe.
      if (distSqToAABB(0, 0, aabb) < PLAZA_RADIUS * PLAZA_RADIUS) {
        continue;
      }
      // Never leave a building standing in the lake.
      if (distSqToAABB(water.cx, water.cz, aabb) < lakeKeepSq) {
        continue;
      }

      buildings.push(candidate);
      colliders.push(aabb);
      nextId++;
    }
  }

  // Perimeter wall render boxes (NOT colliders — see doc comment above). Each
  // is a thin slab hugging the inner face of the map edge at ±half.
  const wallInner = half - WALL_THICKNESS / 2; // center of the wall slab
  const wallHalfT = WALL_THICKNESS / 2;
  // North (+Z) and South (-Z) walls span the full width; East/West span depth.
  buildings.push({ id: nextId++, cx: 0, cz: wallInner, hw: half, hd: wallHalfT, height: WALL_HEIGHT }); // north
  buildings.push({ id: nextId++, cx: 0, cz: -wallInner, hw: half, hd: wallHalfT, height: WALL_HEIGHT }); // south
  buildings.push({ id: nextId++, cx: wallInner, cz: 0, hw: wallHalfT, hd: half, height: WALL_HEIGHT }); // east
  buildings.push({ id: nextId++, cx: -wallInner, cz: 0, hw: wallHalfT, hd: half, height: WALL_HEIGHT }); // west

  // Natural/urban features. Roads are structural; trees avoid the lake.
  const roads = generateRoads();
  const trees = generateTrees(featureRng, water);

  return {
    seed: seed >>> 0,
    size: MAP_SIZE,
    half,
    wallThickness: WALL_THICKNESS,
    buildings,
    colliders,
    trees,
    water,
    waterMode: WATER_MODE,
    roads,
  };
}

/* -------------------------------------------------------------------------- */
/* Collision queries (circle-vs-AABB / circle-vs-circle on XZ)                 */
/* -------------------------------------------------------------------------- */

/**
 * Push a circle of radius `radius` centered at (x, z) out of a single AABB along
 * the minimum-penetration axis. Returns the corrected position and whether it
 * hit.
 *
 * The test inflates the AABB by `radius` (Minkowski sum of the box and the
 * circle): if the circle center is outside that expanded box, the circle can't
 * be touching the box, so we return the input unchanged with `hit = false`.
 * Otherwise we resolve by moving the center to the nearest expanded-box edge —
 * i.e. along whichever of the four axes needs the least movement — which is the
 * standard, cheap, corner-tolerant resolution used inside a relaxation loop.
 */
export function resolveCircleAABB(
  x: number,
  z: number,
  radius: number,
  aabb: AABB,
): { x: number; z: number; hit: boolean } {
  const minX = aabb.minX - radius;
  const maxX = aabb.maxX + radius;
  const minZ = aabb.minZ - radius;
  const maxZ = aabb.maxZ + radius;

  // Outside the expanded box on any axis → no contact.
  if (x <= minX || x >= maxX || z <= minZ || z >= maxZ) {
    return { x, z, hit: false };
  }

  // Penetration depth toward each of the four expanded-box edges.
  const penLeft = x - minX; // push -X out to minX
  const penRight = maxX - x; // push +X out to maxX
  const penDown = z - minZ; // push -Z out to minZ
  const penUp = maxZ - z; // push +Z out to maxZ

  // Resolve along the axis of minimum penetration.
  const minPen = Math.min(penLeft, penRight, penDown, penUp);
  if (minPen === penLeft) return { x: minX, z, hit: true };
  if (minPen === penRight) return { x: maxX, z, hit: true };
  if (minPen === penDown) return { x, z: minZ, hit: true };
  return { x, z: maxZ, hit: true };
}

/**
 * Push a circle of radius `radius` at (x, z) out of a solid disc (a tree trunk,
 * or the lake when water is `blocked`) centered at (cx, cz) with radius `cr`.
 * Resolves along the line of centers to the nearest point where the two circles
 * just touch — the natural circle-vs-circle push-out. Returns the input
 * unchanged with `hit = false` when the circles don't overlap. A body sitting
 * exactly on the disc center is pushed out along +X, a deterministic tie-break.
 */
export function resolveCircleCircle(
  x: number,
  z: number,
  radius: number,
  cx: number,
  cz: number,
  cr: number,
): { x: number; z: number; hit: boolean } {
  const dx = x - cx;
  const dz = z - cz;
  const sum = radius + cr;
  const dSq = dx * dx + dz * dz;
  if (dSq >= sum * sum) return { x, z, hit: false };
  const d = Math.sqrt(dSq);
  if (d < 1e-9) return { x: cx + sum, z: cz, hit: true };
  const s = sum / d;
  return { x: cx + dx * s, z: cz + dz * s, hit: true };
}

/**
 * Resolve a circle of radius `radius` at (x, z) against the whole world: push it
 * out of every building collider and tree, out of the lake shoreline when water
 * is `blocked`, then clamp it inside the perimeter wall. Returns the final safe
 * XZ position. Pure — does not mutate `world`.
 *
 * Colliders are resolved over a few relaxation passes so that a circle wedged
 * into a concave corner (two footprints meeting, or a tree against a wall)
 * settles instead of ping-ponging between them within a single pass. The
 * perimeter clamp is applied LAST so the wall always wins: the center is confined
 * to [-half + wallThickness + radius, +half - wallThickness - radius] on both
 * axes, which places the circle's edge exactly against the wall's inner face.
 */
export function collideCircleXZ(
  world: World,
  x: number,
  z: number,
  radius: number,
): { x: number; z: number } {
  let px = x;
  let pz = z;

  const blockWater = world.water !== null && world.waterMode === 'blocked';

  // 3 relaxation passes lets corners settle without a full solver.
  const PASSES = 3;
  for (let pass = 0; pass < PASSES; pass++) {
    for (let i = 0; i < world.colliders.length; i++) {
      const r = resolveCircleAABB(px, pz, radius, world.colliders[i]);
      px = r.x;
      pz = r.z;
    }
    for (let i = 0; i < world.trees.length; i++) {
      const t = world.trees[i];
      const r = resolveCircleCircle(px, pz, radius, t.x, t.z, t.radius);
      px = r.x;
      pz = r.z;
    }
    if (blockWater) {
      const w = world.water as Lake;
      const r = resolveCircleCircle(px, pz, radius, w.cx, w.cz, w.radius);
      px = r.x;
      pz = r.z;
    }
  }

  // Perimeter wall as a hard clamp (applied last so it can't be overridden).
  const limit = world.half - world.wallThickness - radius;
  px = clamp(px, -limit, limit);
  pz = clamp(pz, -limit, limit);

  return { x: px, z: pz };
}

/* -------------------------------------------------------------------------- */
/* Ray / segment queries (AI perception: avoidance & line-of-sight)            */
/* -------------------------------------------------------------------------- */

/**
 * Slab-method ray-vs-AABB on the XZ plane. Casts a ray from `(ox, oz)` along the
 * UNIT direction `(dx, dz)` and returns the distance to the first intersection
 * with `aabb`, or `null` when the ray misses (or the box lies entirely behind
 * the origin). The box may be inflated by `pad` meters on every side (a Minkowski
 * expansion) so a circle of that radius can be treated as a point — used to keep
 * the NPC's avoidance probes a body-width clear of walls.
 *
 * Returns `0` when the origin already sits inside the padded box.
 */
export function rayAABB(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  aabb: AABB,
  pad = 0,
): number | null {
  const minX = aabb.minX - pad;
  const maxX = aabb.maxX + pad;
  const minZ = aabb.minZ - pad;
  const maxZ = aabb.maxZ + pad;

  // Origin already inside the padded box → contact at distance 0.
  if (ox >= minX && ox <= maxX && oz >= minZ && oz <= maxZ) return 0;

  // Intersect the ray against the X and Z slabs. A zero direction component means
  // the ray is parallel to that slab: it can only ever hit if the origin already
  // lies within the slab's extent, otherwise it misses outright.
  let tmin = -Infinity;
  let tmax = Infinity;

  if (dx !== 0) {
    const tx1 = (minX - ox) / dx;
    const tx2 = (maxX - ox) / dx;
    tmin = Math.max(tmin, Math.min(tx1, tx2));
    tmax = Math.min(tmax, Math.max(tx1, tx2));
  } else if (ox < minX || ox > maxX) {
    return null;
  }

  if (dz !== 0) {
    const tz1 = (minZ - oz) / dz;
    const tz2 = (maxZ - oz) / dz;
    tmin = Math.max(tmin, Math.min(tz1, tz2));
    tmax = Math.min(tmax, Math.max(tz1, tz2));
  } else if (oz < minZ || oz > maxZ) {
    return null;
  }

  // No overlap of the slab intervals, or the box is behind the ray origin.
  if (tmax < tmin || tmax < 0) return null;
  return tmin >= 0 ? tmin : 0;
}

/**
 * Cast a ray of length `maxDist` from `(ox, oz)` along the UNIT direction
 * `(dx, dz)` against every building collider, returning the distance to the
 * nearest hit — clamped to `maxDist` when the ray travels that far unobstructed.
 * `pad` inflates each box (see {@link rayAABB}). Perimeter walls are NOT
 * colliders (they are a position clamp, see {@link generateWorld}), so they are
 * intentionally excluded, exactly like movement collision.
 *
 * Trees and the lake are intentionally NOT tested here: AI perception over the
 * new obstacles is wired up in M9 · t9f (nav grid + avoidance/LoS), so this stays
 * building-only until then.
 */
export function raycastBuildings(
  world: World,
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxDist: number,
  pad = 0,
): number {
  let nearest = maxDist;
  for (let i = 0; i < world.colliders.length; i++) {
    const t = rayAABB(ox, oz, dx, dz, world.colliders[i], pad);
    if (t !== null && t < nearest) nearest = t;
  }
  return nearest;
}

/**
 * True when the straight segment from `(x0, z0)` to `(x1, z1)` is unobstructed
 * by every building — i.e. the two points have clear line of sight on the XZ
 * plane. The NPC uses this for target acquisition (t4b): a human is only
 * "visible" when no building stands between it and the zombie.
 */
export function hasLineOfSight(
  world: World,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): boolean {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return true;
  const hit = raycastBuildings(world, x0, z0, dx / dist, dz / dist, dist, 0);
  // Clear iff nothing was struck before the ray reached the target point.
  return hit >= dist - 1e-4;
}
