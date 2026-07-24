/**
 * The Crawling Dark — seeded town geometry & 2.5D collision (M2 · t2a).
 *
 * The "town" is a bounded grid of building boxes arranged around streets, with
 * a clear central plaza and a perimeter wall so no one runs off the map. It is
 * generated **purely from a single integer seed**, which is the whole point:
 * the authoritative server and every client run {@link generateWorld} with the
 * same `mapSeed` (see the WELCOME message in the protocol) and end up with
 * byte-for-byte identical geometry — same building list, same colliders. The
 * client renders the buildings as box meshes; the server collides players
 * against the very same AABB footprints. Because of that shared-source-of-truth
 * guarantee, this module must be *fully deterministic*: it NEVER calls
 * `Math.random`; all variation comes from the inline {@link mulberry32} PRNG.
 *
 * Collision model (see docs/DESIGN.md §4 "World & collision"): players are
 * cylinders on a flat ground plane, so collision is resolved as a 2.5D
 * **circle-vs-AABB** problem on the **XZ plane**. Y (jump/gravity) is handled
 * elsewhere in `sim.ts`. This avoids a full 3D physics engine while still
 * feeling solid, and lets us later swap the box meshes for GLTF town assets
 * without touching collision — collision only ever reads the AABB list.
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

/** The fully-resolved, deterministic town. */
export interface World {
  seed: number;
  size: number; // == MAP_SIZE (full square edge length)
  half: number; // == MAP_SIZE / 2 (perimeter half-extent)
  wallThickness: number; // perimeter wall thickness (meters)
  buildings: Building[];
  /** Every solid AABB collision footprint (building footprints; NOT the perimeter — perimeter is a clamp). */
  colliders: AABB[];
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

/** Building render heights are randomized within this closed range (meters). */
const MIN_BUILDING_HEIGHT = 4.0;
const MAX_BUILDING_HEIGHT = 14.0;

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
 * point is inside). Used to test plaza clearance without a `sqrt`.
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
 * Deterministically build the whole town from a single integer seed. Same seed
 * => identical geometry (identical `buildings` and `colliders` arrays).
 *
 * Layout: a `N_BLOCKS × N_BLOCKS` grid of city blocks spans the region
 * [-TOWN_HALF, +TOWN_HALF] on X and Z. Each block holds at most one building,
 * with its footprint and height jittered by the PRNG for character but always
 * kept inside the block's inner area (leaving STREET_HALF clearance to every
 * cell edge) — so buildings never overlap each other and never spill into the
 * streets between them. Any candidate whose footprint would reach inside the
 * central {@link PLAZA_RADIUS} plaza is dropped, keeping the spawn area clear.
 *
 * The four perimeter walls are emitted as thin render `Building` boxes so the
 * client can draw the map edge, but they are intentionally left OUT of
 * `colliders`: the wall is enforced as a position clamp in
 * {@link collideCircleXZ}, and adding it as push-out boxes too would
 * double-resolve against that clamp.
 */
export function generateWorld(seed: number): World {
  const rng = mulberry32(seed);

  const half = MAP_SIZE / 2;
  const cellSize = (2 * TOWN_HALF) / N_BLOCKS;
  // Half-width of the area within a cell a building may occupy. Keeping every
  // footprint inside this bound guarantees ≥ STREET_HALF clearance to the cell
  // edge, hence ≥ 2*STREET_HALF between any two neighbouring buildings.
  const innerHalf = cellSize / 2 - STREET_HALF;

  const buildings: Building[] = [];
  const colliders: AABB[] = [];
  let nextId = 0;

  for (let ix = 0; ix < N_BLOCKS; ix++) {
    for (let iz = 0; iz < N_BLOCKS; iz++) {
      const cellCenterX = -TOWN_HALF + cellSize * (ix + 0.5);
      const cellCenterZ = -TOWN_HALF + cellSize * (iz + 0.5);

      // Draw the footprint & height. We always consume the same number of PRNG
      // values per cell (even when the building is later dropped) so the stream
      // stays aligned and the whole town stays deterministic.
      const hw = MIN_HALF_EXTENT + rng() * (MAX_HALF_EXTENT - MIN_HALF_EXTENT);
      const hd = MIN_HALF_EXTENT + rng() * (MAX_HALF_EXTENT - MIN_HALF_EXTENT);
      // Jitter the center, but never enough to breach the cell's inner area.
      const maxOffX = innerHalf - hw;
      const maxOffZ = innerHalf - hd;
      const cx = cellCenterX + (rng() * 2 - 1) * maxOffX;
      const cz = cellCenterZ + (rng() * 2 - 1) * maxOffZ;
      const height =
        MIN_BUILDING_HEIGHT + rng() * (MAX_BUILDING_HEIGHT - MIN_BUILDING_HEIGHT);

      const candidate: Building = { id: nextId, cx, cz, hw, hd, height };
      const aabb = buildingAABB(candidate);

      // Keep the central plaza clear: skip any building whose footprint reaches
      // inside the plaza circle. This is what makes the spawn ring safe.
      if (distSqToAABB(0, 0, aabb) < PLAZA_RADIUS * PLAZA_RADIUS) {
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

  return {
    seed: seed >>> 0,
    size: MAP_SIZE,
    half,
    wallThickness: WALL_THICKNESS,
    buildings,
    colliders,
  };
}

/* -------------------------------------------------------------------------- */
/* Collision queries (circle-vs-AABB on XZ)                                    */
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
 * Resolve a circle of radius `radius` at (x, z) against the whole world: push it
 * out of every building collider, then clamp it inside the perimeter wall.
 * Returns the final safe XZ position. Pure — does not mutate `world`.
 *
 * Buildings are resolved over a few relaxation passes so that a circle wedged
 * into a concave corner (two footprints meeting) settles instead of ping-ponging
 * between them within a single pass. The perimeter clamp is applied LAST so the
 * wall always wins: the center is confined to
 * [-half + wallThickness + radius, +half - wallThickness - radius] on both axes,
 * which places the circle's edge exactly against the wall's inner face.
 */
export function collideCircleXZ(
  world: World,
  x: number,
  z: number,
  radius: number,
): { x: number; z: number } {
  let px = x;
  let pz = z;

  // 3 relaxation passes lets corners settle without a full solver.
  const PASSES = 3;
  for (let pass = 0; pass < PASSES; pass++) {
    for (let i = 0; i < world.colliders.length; i++) {
      const r = resolveCircleAABB(px, pz, radius, world.colliders[i]);
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
