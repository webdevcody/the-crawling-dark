/**
 * The Crawling Dark — natural / urban environment pass (M9 · t9e client).
 *
 * Renders the world's non-building features — the perimeter forest, the street
 * grid, and a light scatter of rocks & bushes — from the same seeded {@link World}
 * everything else derives from, so what you see still matches what the server
 * collides against (collision for these lives in shared; this file is render-only).
 *
 * The guiding constraint is the same one that rules {@link scene/Atmosphere}:
 * performance. The forest is ~740 solid trees, so it is drawn with instancing —
 * ONE {@link THREE.InstancedMesh} for every trunk and ONE for every foliage cone,
 * two draw calls for the whole forest rather than 740 meshes. The roads are merged
 * into a single flat ribbon geometry (one draw call for the entire street grid),
 * and the scatter props are two more instanced meshes (rocks + bushes). So the
 * whole environment adds only ~5 draw calls no matter how dense the world gets.
 *
 * Scatter placement is DETERMINISTIC: it is seeded from `world.seed` through a
 * local {@link mulberry32} copy (mirroring the shared world generator's inline
 * PRNG) and never touches `Math.random`, so every client lays the same rocks and
 * bushes in the same spots for a given town.
 */

import * as THREE from 'three';
import { buildingAABB, type AABB, type Road, type World } from '@crawling-dark/shared';

/* -------------------------------------------------------------------------- */
/* Layout constants (mirror the shared world generator)                        */
/* -------------------------------------------------------------------------- */

/**
 * Outer half-extent of the town's building grid / ring road, mirroring
 * `TOWN_HALF` in `shared/src/world.ts`. Used only to bias scatter placement into
 * believable town-edge bands; it is layout data, not collision, so a local copy
 * is safe (the props are client-only render dressing).
 */
const TOWN_HALF = 54.0;

/** The guaranteed building-free plaza radius, mirroring `PLAZA_RADIUS` in shared. */
const PLAZA_RADIUS = 12.0;

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

/** Dark bark — barely catches the moon, so trunks read as silhouettes in the fog. */
const TRUNK_COLOR = 0x241c14;

/** Deep, cold evergreen for the canopy; per-tree brightness is jittered around it. */
const FOLIAGE_COLOR = 0x18291d;

/** Wet, near-black asphalt for the streets. */
const ROAD_COLOR = 0x0c1117;

/** Damp grey stone for scatter rocks. */
const ROCK_COLOR = 0x2a2f36;

/** Low shrub green, a touch lighter than the canopy so bushes don't vanish. */
const BUSH_COLOR = 0x1e3324;

/* -------------------------------------------------------------------------- */
/* Tree proportions                                                            */
/* -------------------------------------------------------------------------- */

/** Trunk radius as a fraction of the tree's collision radius (a slim bole). */
const TRUNK_RADIUS_FRAC = 0.4;
/** Trunk height as a fraction of the tree's total render height. */
const TRUNK_HEIGHT_FRAC = 0.3;
/** Canopy base radius as a multiple of the collision radius (a full, wide crown). */
const CANOPY_RADIUS_MULT = 1.8;
/** Canopy height as a fraction of the tree's total render height. */
const CANOPY_HEIGHT_FRAC = 0.75;

/* -------------------------------------------------------------------------- */
/* Road ribbons                                                                */
/* -------------------------------------------------------------------------- */

/** Height (meters) of the road ribbons above `y = 0` — clears ground + grid, under the water. */
const ROAD_Y = 0.02;

/* -------------------------------------------------------------------------- */
/* Scatter props                                                               */
/* -------------------------------------------------------------------------- */

/** How many rocks / bushes to place. Kept modest so the town-edge stays sparse dressing. */
const ROCK_COUNT = 48;
const BUSH_COUNT = 36;

/** Cap on placement attempts per prop kind, so rejection sampling can't loop forever. */
const SCATTER_MAX_ATTEMPTS = 4000;

/** Keep scatter this far (meters) clear of building footprints and the lake shore. */
const SCATTER_CLEARANCE = 1.5;

/** Keep scatter off the tarmac by at least half a road-width plus this margin. */
const ROAD_CLEARANCE = 1.0;

/**
 * Believable placement bands as Chebyshev distance `max(|x|,|z|)` from the origin:
 * a front-yard strip just outside the rim houses, and a strip fronting the forest.
 * Both hug the town edge and the ring road (which is skipped via {@link ROAD_CLEARANCE}),
 * which is where loose rocks and roadside shrubs actually gather.
 */
const SCATTER_BANDS: ReadonlyArray<readonly [number, number]> = [
  [PLAZA_RADIUS + 4, TOWN_HALF - 4], // 16..50 — town interior / front yards
  [TOWN_HALF + 1, TOWN_HALF + 3.5], // 55..57.5 — the forest-edge verge
];

/* -------------------------------------------------------------------------- */
/* Deterministic PRNG (local copy of the shared world generator's mulberry32)   */
/* -------------------------------------------------------------------------- */

/**
 * mulberry32 — the exact tiny deterministic PRNG used by `shared/src/world.ts`,
 * copied inline (never `Math.random`) so scatter placement is reproducible from
 * `world.seed` on every client. Kept identical so the behaviour can't drift.
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

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Squared XZ distance from (x, z) to the nearest point on `aabb` (0 inside). */
function distSqToAABB(x: number, z: number, aabb: AABB): number {
  const dx = x < aabb.minX ? aabb.minX - x : x > aabb.maxX ? x - aabb.maxX : 0;
  const dz = z < aabb.minZ ? aabb.minZ - z : z > aabb.maxZ ? z - aabb.maxZ : 0;
  return dx * dx + dz * dz;
}

/** Squared XZ distance from point (px, pz) to the segment (ax,az)–(bx,bz). */
function distSqToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const vx = bx - ax;
  const vz = bz - az;
  const wx = px - ax;
  const wz = pz - az;
  const len2 = vx * vx + vz * vz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wz * vz) / len2)) : 0;
  const cx = ax + t * vx;
  const cz = az + t * vz;
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz;
}

/* -------------------------------------------------------------------------- */
/* Forest — two instanced meshes (trunks + foliage cones)                       */
/* -------------------------------------------------------------------------- */

/**
 * Build the whole forest as exactly two {@link THREE.InstancedMesh}es: one unit
 * trunk cylinder and one unit foliage cone, each carrying one instance per tree.
 * Per-instance transforms scale a unit trunk/cone by the tree's radius/height and
 * seat it at the tree's XZ, so 740 trees cost two draw calls. Foliage instances
 * get a subtle deterministic brightness jitter (via `setColorAt`) so the canopy
 * doesn't read as one flat green sheet.
 *
 * Both base geometries are authored with their BASE at `y = 0` (unit cylinder
 * lifted by 0.5; unit cone lifted by 0.5) so a per-instance Y-scale grows them
 * upward from the ground without a separate offset.
 */
function buildForest(world: World, rng: () => number): THREE.InstancedMesh[] {
  const count = world.trees.length;

  // Unit trunk: radius 1, height 1, base on y = 0. Few radial sides — it's tiny + distant.
  const trunkGeo = new THREE.CylinderGeometry(1, 1, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshStandardMaterial({
    color: TRUNK_COLOR,
    roughness: 1,
    metalness: 0,
  });

  // Unit foliage: a cone of base-radius 1, height 1, base on y = 0.
  const foliageGeo = new THREE.ConeGeometry(1, 1, 7);
  foliageGeo.translate(0, 0.5, 0);
  const foliageMat = new THREE.MeshStandardMaterial({
    color: FOLIAGE_COLOR,
    roughness: 1,
    metalness: 0,
  });

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  const foliage = new THREE.InstancedMesh(foliageGeo, foliageMat, count);
  trunks.name = 'forest-trunks';
  foliage.name = 'forest-foliage';

  // Instances blanket the map ring; skip frustum culling (the base geometry's
  // bounds don't cover the spread-out instances) so the forest never pops out.
  trunks.frustumCulled = false;
  foliage.frustumCulled = false;
  trunks.castShadow = true;
  foliage.castShadow = true;

  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion(); // identity — trees don't rotate
  const scale = new THREE.Vector3();
  const tint = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const t = world.trees[i];
    const trunkHeight = t.height * TRUNK_HEIGHT_FRAC;
    const trunkRadius = t.radius * TRUNK_RADIUS_FRAC;

    // Trunk: seat at the tree, scale the unit cylinder to (radius, height, radius).
    pos.set(t.x, 0, t.z);
    scale.set(trunkRadius, trunkHeight, trunkRadius);
    matrix.compose(pos, quat, scale);
    trunks.setMatrixAt(i, matrix);

    // Foliage: sit the cone atop the trunk, wider crown, taller than the bole.
    pos.set(t.x, trunkHeight, t.z);
    scale.set(t.radius * CANOPY_RADIUS_MULT, t.height * CANOPY_HEIGHT_FRAC, t.radius * CANOPY_RADIUS_MULT);
    matrix.compose(pos, quat, scale);
    foliage.setMatrixAt(i, matrix);

    // Deterministic per-tree brightness (0.8..1.15×) so the canopy has depth.
    const b = 0.8 + rng() * 0.35;
    tint.setRGB(b, b, b);
    foliage.setColorAt(i, tint);
  }

  trunks.instanceMatrix.needsUpdate = true;
  foliage.instanceMatrix.needsUpdate = true;
  if (foliage.instanceColor !== null) foliage.instanceColor.needsUpdate = true;

  return [trunks, foliage];
}

/* -------------------------------------------------------------------------- */
/* Roads — one merged flat ribbon geometry                                      */
/* -------------------------------------------------------------------------- */

/**
 * Merge every road polyline into ONE flat ribbon mesh (a single draw call for the
 * whole street grid). Each segment of each polyline becomes a quad (two triangles)
 * a road-width wide, laid on the ground at {@link ROAD_Y}. Consecutive-point
 * iteration handles both the straight 2-point interior lanes and the closed-loop
 * 5-point ring road (whose last point repeats the first). Overlaps at
 * intersections are coplanar and same-coloured, so they never z-fight visibly.
 */
function buildRoads(roads: Road[]): THREE.Mesh {
  const positions: number[] = [];

  for (const road of roads) {
    const half = road.width / 2;
    const pts = road.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      // Left-hand perpendicular, scaled to half the road width.
      const px = (-dz / len) * half;
      const pz = (dx / len) * half;

      // Quad corners; wound so both triangles' normals point +Y (up), i.e. the
      // ribbon's front face is the one you see from above.
      const a1x = a.x + px, a1z = a.z + pz;
      const a2x = a.x - px, a2z = a.z - pz;
      const b1x = b.x + px, b1z = b.z + pz;
      const b2x = b.x - px, b2z = b.z - pz;

      positions.push(
        a1x, ROAD_Y, a1z, b1x, ROAD_Y, b1z, a2x, ROAD_Y, a2z,
        a2x, ROAD_Y, a2z, b1x, ROAD_Y, b1z, b2x, ROAD_Y, b2z,
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals(); // all up, but keeps the standard material happy

  const material = new THREE.MeshStandardMaterial({
    color: ROAD_COLOR,
    roughness: 1,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'roads';
  mesh.receiveShadow = true; // catch building / tree shadows raked across the street
  return mesh;
}

/* -------------------------------------------------------------------------- */
/* Scatter props — deterministic rocks + bushes, instanced                      */
/* -------------------------------------------------------------------------- */

/**
 * True when (x, z) is a believable, unobstructed scatter spot: inside one of the
 * town-edge {@link SCATTER_BANDS}, clear of the plaza, every building footprint,
 * the lake, and every road. Used by rejection sampling below.
 */
function isScatterSpotClear(world: World, x: number, z: number): boolean {
  const cheb = Math.max(Math.abs(x), Math.abs(z));
  let inBand = false;
  for (const [lo, hi] of SCATTER_BANDS) {
    if (cheb >= lo && cheb <= hi) {
      inBand = true;
      break;
    }
  }
  if (!inBand) return false;

  // Never in the spawn plaza.
  if (x * x + z * z < PLAZA_RADIUS * PLAZA_RADIUS) return false;

  // Clear of every building footprint.
  const clr = SCATTER_CLEARANCE;
  for (const c of world.colliders) {
    if (distSqToAABB(x, z, c) < clr * clr) return false;
  }

  // Clear of the lake shore (props don't float).
  if (world.water !== null) {
    const dx = x - world.water.cx;
    const dz = z - world.water.cz;
    const keep = world.water.radius + clr;
    if (dx * dx + dz * dz < keep * keep) return false;
  }

  // Off the tarmac (half a road-width plus a margin from any segment).
  for (const road of world.roads) {
    const keep = road.width / 2 + ROAD_CLEARANCE;
    const keepSq = keep * keep;
    const pts = road.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (distSqToSegment(x, z, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z) < keepSq) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Build one {@link THREE.InstancedMesh} of `count` scatter props from a shared base
 * geometry/material, seating each at a deterministically-sampled clear spot with a
 * random yaw and a size in `[minScale, maxScale]`. `baseY` lifts the instance so a
 * unit-ish prop rests on the ground. Returns `null` when the geometry never lands a
 * single spot (defensive — the bands are always wide enough in practice).
 */
function buildScatter(
  world: World,
  rng: () => number,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
  minScale: number,
  maxScale: number,
  baseY: number,
  name: string,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = true;

  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();

  const reach = TOWN_HALF + 4; // sampling square comfortably covers every band
  let placed = 0;
  for (let attempt = 0; attempt < SCATTER_MAX_ATTEMPTS && placed < count; attempt++) {
    const x = (rng() * 2 - 1) * reach;
    const z = (rng() * 2 - 1) * reach;
    const s = minScale + rng() * (maxScale - minScale);
    const yaw = rng() * Math.PI * 2;
    if (!isScatterSpotClear(world, x, z)) continue;

    euler.set(0, yaw, 0);
    quat.setFromEuler(euler);
    pos.set(x, baseY * s, z);
    scale.set(s, s, s);
    matrix.compose(pos, quat, scale);
    mesh.setMatrixAt(placed, matrix);
    placed += 1;
  }

  // If sampling fell short, collapse the unused tail instances to zero size so no
  // stray prop is drawn at the origin (InstancedMesh always renders `count` slots).
  if (placed < count) {
    matrix.compose(
      pos.set(0, -1000, 0),
      quat.identity(),
      scale.set(0, 0, 0),
    );
    for (let i = placed; i < count; i++) mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/**
 * Build both scatter meshes (rocks + bushes) from one shared PRNG stream, so their
 * placements are deterministic and interleaved from `world.seed`. Rocks are squat,
 * faceted stones; bushes are small rounded shrubs a touch taller.
 */
function buildScatterProps(world: World, rng: () => number): THREE.InstancedMesh[] {
  const rockGeo = new THREE.IcosahedronGeometry(0.5, 0);
  const rockMat = new THREE.MeshStandardMaterial({
    color: ROCK_COLOR,
    roughness: 1,
    metalness: 0,
  });
  const rocks = buildScatter(world, rng, rockGeo, rockMat, ROCK_COUNT, 0.5, 1.1, 0.35, 'rocks');

  const bushGeo = new THREE.DodecahedronGeometry(0.6, 0);
  const bushMat = new THREE.MeshStandardMaterial({
    color: BUSH_COLOR,
    roughness: 1,
    metalness: 0,
  });
  const bushes = buildScatter(world, rng, bushGeo, bushMat, BUSH_COUNT, 0.6, 1.2, 0.4, 'bushes');

  return [rocks, bushes];
}

/* -------------------------------------------------------------------------- */
/* Public builder + teardown                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the whole environment for `world` as one {@link THREE.Group}: the forest
 * (two instanced meshes), the merged road ribbon, and the scatter props (two more
 * instanced meshes) — ~5 draw calls total. The group is returned (not added to a
 * scene) so the caller owns insertion and, via {@link disposeEnvironment}, cleanup.
 * All randomness is seeded from `world.seed`, so the result is identical per town.
 */
export function buildEnvironment(world: World): THREE.Group {
  const group = new THREE.Group();
  group.name = 'environment';

  // One PRNG stream for every client-side placement choice (foliage tint + scatter),
  // seeded from the world seed but offset so it never mirrors the shared streams.
  const rng = mulberry32((world.seed ^ 0x1b56c4e9) >>> 0);

  for (const m of buildForest(world, rng)) group.add(m);
  group.add(buildRoads(world.roads));
  for (const m of buildScatterProps(world, rng)) group.add(m);

  return group;
}

/**
 * Dispose every geometry / material (and instance buffer) under an environment
 * group — mirroring `disposeTown` — so a town regeneration leaks nothing. Base
 * geometries and materials are shared per instanced mesh, and each {@link
 * THREE.InstancedMesh} additionally owns instance-attribute buffers freed by its
 * own `dispose()`.
 */
export function disposeEnvironment(group: THREE.Group): void {
  const seenMaterials = new Set<THREE.Material>();
  for (const child of group.children) {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const mat = child.material as THREE.Material;
      if (!seenMaterials.has(mat)) {
        seenMaterials.add(mat);
        mat.dispose();
      }
      // InstancedMesh also owns instanceMatrix / instanceColor buffers.
      if (child instanceof THREE.InstancedMesh) child.dispose();
    }
  }
}
