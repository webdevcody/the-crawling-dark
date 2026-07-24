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
 * and the scatter props are two more instanced meshes (rocks + bushes). A single
 * forest-floor annulus (M10 · t10e) adds one more. So the whole environment adds
 * only ~6 draw calls no matter how dense the world gets.
 *
 * M10 (t10b/t10e) also moves these surfaces off flat palette colours onto tiled
 * procedural PBR materials from {@link scene/TextureLibrary} — asphalt on the
 * roads, bark on the trunks, an alpha-cutout needle canopy, and the forest-floor
 * blend — all offline-safe (a failed generator falls back to the flat colour) and
 * deterministic, so nothing about the draw-call budget or determinism changes.
 *
 * Scatter placement is DETERMINISTIC: it is seeded from `world.seed` through a
 * local {@link mulberry32} copy (mirroring the shared world generator's inline
 * PRNG) and never touches `Math.random`, so every client lays the same rocks and
 * bushes in the same spots for a given town.
 */

import * as THREE from 'three';
import { buildingAABB, type AABB, type Road, type World } from '@crawling-dark/shared';
import {
  TextureLibrary,
  makeStandardMaterial,
  makeAlbedoTexture,
  makeNormalTexture,
  makeGrayscaleTexture,
  fbm,
  mixRgb,
  type PBRTextureSet,
} from './TextureLibrary';

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

/**
 * Dark mossy needle-litter under the perimeter forest (M10 · t10e). Sits between
 * the canopy green and the near-black ground so the tree band reads as forest
 * floor, not bare dirt. Used as the tint/fallback for the forest-floor material.
 */
const FOREST_FLOOR_COLOR = 0x131a12;

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

/**
 * Meters of world span per asphalt tile (M10 · t10b). The road geometry has no
 * natural UVs (it is a merged ribbon), so we project a *planar world-space* UV —
 * `u = x / ROAD_TILE_METERS`, `v = z / ROAD_TILE_METERS` — which makes the grain
 * tile continuously and seamlessly across every segment AND across intersections
 * (overlapping quads share the same world position → the same UV → no visible
 * seam). ~5 m keeps the aggregate speckle believable at street scale. Because the
 * tiling is baked into these UVs, the material uses `repeat: 1` (no double-tile).
 */
const ROAD_TILE_METERS = 5;

/* -------------------------------------------------------------------------- */
/* Forest floor                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Height (meters) of the forest-floor annulus above `y = 0` (M10 · t10e). Seated
 * between the grid (`0.01`) and the road ribbons ({@link ROAD_Y} `= 0.02`) so it
 * never z-fights either: it reads over the base ground/grid but the tarmac still
 * draws on top of it where a road grazes the tree band.
 */
const FOREST_FLOOR_Y = 0.015;

/**
 * Meters of world span per forest-floor tile — matched to `GROUND_TILE_METERS`
 * (8) in `main.ts` so the litter grain reads at the same density as the base
 * dirt it blends over. Like the road, the annulus is given a planar world-space
 * UV (`x / TILE`, `z / TILE`) rather than RingGeometry's awkward radial UV, so
 * the tiling is baked in and the material uses `repeat: 1`.
 */
const FOREST_FLOOR_TILE_METERS = 8;

/** Resolution (power-of-two) of every procedural surface map generated here. */
const TEXTURE_SIZE = 256;

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
/* Procedural surface textures (M10 · t10b road + t10e nature)                  */
/* -------------------------------------------------------------------------- */
/*
 * These generators mirror `makeGroundDirtSet` in {@link scene/TextureLibrary}:
 * seamless `fbm` painted to an sRGB albedo canvas, an analytic tangent-space
 * normal from a matching height field, and a linear grayscale roughness field.
 * Everything is DETERMINISTIC (fixed `fbm` seeds, never `Math.random`) so every
 * client generates byte-identical maps, and every field wraps so the maps tile
 * without a seam. They are wrapped in `TextureLibrary.get(name, ...)` at the call
 * sites so each runs at most once and the textures are library-owned (materials
 * must NOT dispose them). Colours stay deep and cold: the albedo maps are dark
 * and further multiplied by the surface tint (ROAD/TRUNK/FOLIAGE/FOREST_FLOOR
 * colour), so the night fog swallows them exactly like the flat-colour fallback.
 *
 * Anisotropy in the horizontal noise scale is the trick behind bark/needle
 * streaks: `fbm(u * sx, v * sy)` with INTEGER `sx, sy` stays perfectly periodic
 * (so it still tiles), while `sx > sy` packs high frequency across the trunk to
 * draw grain that runs *up* it.
 */

/**
 * Dark, wet asphalt (M10 · t10b). A near-black bitumen binder with sparse pale
 * aggregate speckle (fine high-frequency noise), faint hairline cracks, a bump
 * normal for the aggregate, and a broadly-rough field (~0.89–0.97) that eases off
 * in the damper patches. Multiplied by {@link ROAD_COLOR} at the material.
 */
function makeAsphaltSet(size = TEXTURE_SIZE): PBRTextureSet {
  const seed = 4207;
  const BINDER = 0x181c22; // near-black bitumen matrix (wet sheen)
  const AGGREGATE = 0x41474f; // pale grey stones set into the binder
  const map = makeAlbedoTexture(size, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const u = x / s;
        const v = y / s;
        const grain = fbm(u, v, { basePeriod: 48, octaves: 3, seed }); // fine aggregate
        const patch = fbm(u, v, { basePeriod: 6, octaves: 4, seed: seed + 5 }); // wet/dry patches
        // Only the top of the grain distribution surfaces as visible stones.
        const stone = Math.max(0, grain - 0.55) / 0.45;
        // Thin cracks: a ridge where a low-freq field crosses its own midline.
        const crack = 1 - Math.min(1, Math.abs(fbm(u, v, { basePeriod: 5, octaves: 3, seed: seed + 9 }) - 0.5) * 9);
        let t = Math.min(1, stone * 0.85 + patch * 0.12);
        t *= 1 - crack * 0.55; // cracks pull the tone back toward the dark binder
        const [r, g, b] = mixRgb(BINDER, AGGREGATE, t);
        const o = (y * s + x) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });

  const heightAt = (u: number, v: number): number =>
    fbm(u, v, { basePeriod: 48, octaves: 3, seed }) * 0.7 +
    fbm(u, v, { basePeriod: 6, octaves: 3, seed: seed + 5 }) * 0.3;
  const normalMap = makeNormalTexture(size, heightAt, 1.0);

  const roughnessMap = makeGrayscaleTexture(size, (x, y) => {
    // Asphalt is rough; damp patches (higher `patch`) are a touch glossier.
    const patch = fbm(x / size, y / size, { basePeriod: 6, octaves: 4, seed: seed + 5 });
    return 0.97 - patch * 0.08;
  });

  return { map, normalMap, roughnessMap };
}

/**
 * Tree bark (M10 · t10e). Dark-brown vertical-streak grain: `fbm(u * 5, v)` puts
 * high frequency around the trunk and low frequency up it, so the ridges run
 * vertically; a finer cross-grain breaks the streaks up. A matching bump normal
 * gives the fissures relief. Multiplied by {@link TRUNK_COLOR}; the ridge brown
 * is kept bright enough that the streaks survive that dark tint.
 */
function makeBarkSet(size = TEXTURE_SIZE): PBRTextureSet {
  const seed = 5150;
  const BARK_DARK = 0x2c2016; // shadowed fissures
  const BARK_LIGHT = 0x5a4630; // lit ridges
  const streak = (u: number, v: number): number => fbm(u * 5, v, { basePeriod: 4, octaves: 4, seed });
  const map = makeAlbedoTexture(size, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const u = x / s;
        const v = y / s;
        const grain = fbm(u * 3, v * 7, { basePeriod: 6, octaves: 3, seed: seed + 11 });
        const t = Math.min(1, Math.max(0, streak(u, v) * 0.85 + grain * 0.2 - 0.05));
        const [r, g, b] = mixRgb(BARK_DARK, BARK_LIGHT, t);
        const o = (y * s + x) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });

  const normalMap = makeNormalTexture(
    size,
    (u, v) => streak(u, v) * 0.8 + fbm(u * 3, v * 7, { basePeriod: 6, octaves: 3, seed: seed + 11 }) * 0.2,
    1.5,
  );
  const roughnessMap = makeGrayscaleTexture(size, (x, y) => 0.95 - streak(x / size, y / size) * 0.1);

  return { map, normalMap, roughnessMap };
}

/**
 * Evergreen needle albedo (M10 · t10e): dark green mottling around
 * {@link FOLIAGE_COLOR}. Only the base colour is generated — the ragged silhouette
 * comes from a separate alpha mask ({@link makeNeedleAlphaTexture}). The map
 * multiplies with the per-instance `setColorAt` brightness jitter, which is fine.
 */
function makeFoliageSet(size = TEXTURE_SIZE): PBRTextureSet {
  const seed = 8080;
  const NEEDLE_DARK = 0x16241a;
  const NEEDLE_LIGHT = 0x33513a;
  const map = makeAlbedoTexture(size, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const u = x / s;
        const v = y / s;
        const mottle = fbm(u * 3, v * 3, { basePeriod: 6, octaves: 4, seed });
        const t = Math.min(1, Math.max(0, mottle * 0.9 + 0.05));
        const [r, g, b] = mixRgb(NEEDLE_DARK, NEEDLE_LIGHT, t);
        const o = (y * s + x) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  return { map, normalMap: null, roughnessMap: null };
}

/**
 * Ragged needle alpha mask (M10 · t10e): a linear grayscale field of vertical
 * needle strokes (high vertical frequency) modulated by broader clumps, biased so
 * the canopy stays *mostly* opaque but tears into gaps. Used as an `alphaMap` with
 * `alphaTest` so the cone reads as needles, not a smooth solid — and, being a
 * cutout (not `transparent`), it needs no depth sorting. Returns `null`
 * offline-safe, in which case the material stays fully solid (no `alphaTest`).
 */
function makeNeedleAlphaTexture(size = TEXTURE_SIZE): THREE.Texture | null {
  const seed = 8081;
  return makeGrayscaleTexture(size, (x, y) => {
    const u = x / size;
    const v = y / size;
    const needles = fbm(u * 6, v * 10, { basePeriod: 4, octaves: 4, seed });
    const clump = fbm(u * 2, v * 2, { basePeriod: 5, octaves: 3, seed: seed + 3 });
    return Math.min(1, Math.max(0, needles * 0.8 + clump * 0.5 - 0.05));
  });
}

/**
 * Forest-floor litter (M10 · t10e): broad mossy patches over a fine needle grain,
 * mixing dark soil litter and patchy moss, with a matching bump normal and rough
 * field. Multiplied by {@link FOREST_FLOOR_COLOR} so it blends the tree band into
 * the base ground rather than brightening it.
 */
function makeForestFloorSet(size = TEXTURE_SIZE): PBRTextureSet {
  const seed = 9021;
  const LITTER = 0x141a11; // dark needle litter / soil
  const MOSS = 0x2a3a22; // patchy moss
  const map = makeAlbedoTexture(size, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const u = x / s;
        const v = y / s;
        const moss = fbm(u, v, { basePeriod: 4, octaves: 4, seed });
        const litter = fbm(u, v, { basePeriod: 20, octaves: 3, seed: seed + 7 });
        const t = Math.min(1, Math.max(0, moss * 0.8 + litter * 0.25 - 0.05));
        const [r, g, b] = mixRgb(LITTER, MOSS, t);
        const o = (y * s + x) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });

  const normalMap = makeNormalTexture(
    size,
    (u, v) =>
      fbm(u, v, { basePeriod: 20, octaves: 3, seed: seed + 7 }) * 0.6 +
      fbm(u, v, { basePeriod: 5, octaves: 3, seed }) * 0.4,
    1.2,
  );
  const roughnessMap = makeGrayscaleTexture(
    size,
    (x, y) => 0.96 - fbm(x / size, y / size, { basePeriod: 4, octaves: 4, seed }) * 0.12,
  );

  return { map, normalMap, roughnessMap };
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
  // M10 (t10e): dark bark PBR set on the cylinder's own UVs. `repeat: [2, 3]`
  // tiles the grain twice around the bole and three times up it, so a slim trunk
  // doesn't smear the streaks; TRUNK_COLOR stays the tint/fallback. The set is
  // library-owned (never disposed by the material).
  const trunkMat = makeStandardMaterial(TextureLibrary.get('bark', () => makeBarkSet()), {
    repeat: [2, 3],
    color: TRUNK_COLOR,
    roughness: 1,
    metalness: 0,
    normalScale: 1,
  });

  // Unit foliage: a cone of base-radius 1, height 1, base on y = 0.
  const foliageGeo = new THREE.ConeGeometry(1, 1, 7);
  foliageGeo.translate(0, 0.5, 0);
  // M10 (t10e): evergreen albedo (multiplies with the per-instance brightness
  // jitter from `setColorAt` — that still works) plus an alpha cutout that tears a
  // ragged needle silhouette into the cone. `alphaTest` is only wired when the
  // mask actually generated, so an offline/headless client renders a solid cone
  // (the graceful fallback) instead of an all-transparent one. `transparent`
  // stays false → an opaque cutout that needs no depth sort. Shadows use the
  // default (non-alpha-tested) depth material, so the cast shadow is the full cone
  // — acceptable per t10e (we don't over-engineer alpha-tested shadows).
  const foliageAlpha = TextureLibrary.get('foliage-alpha', () => ({
    map: makeNeedleAlphaTexture(),
    normalMap: null,
    roughnessMap: null,
  })).map;
  const foliageExtra: THREE.MeshStandardMaterialParameters =
    foliageAlpha !== null ? { alphaMap: foliageAlpha, alphaTest: 0.4 } : {};
  const foliageMat = makeStandardMaterial(TextureLibrary.get('foliage', () => makeFoliageSet()), {
    color: FOLIAGE_COLOR,
    roughness: 1,
    metalness: 0,
    extra: foliageExtra,
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
  // M10 (t10b): the merged ribbon has no intrinsic UVs, so we project a planar
  // world-space UV in lockstep with each position we push (one uv pair per vertex,
  // same order). `u = x / ROAD_TILE_METERS`, `v = z / ROAD_TILE_METERS` — the grain
  // then tiles continuously across every segment and every intersection, because
  // coincident world positions map to the same UV. See {@link ROAD_TILE_METERS}.
  const uvs: number[] = [];
  const invTile = 1 / ROAD_TILE_METERS;

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
      // Same six vertices, planar-projected to (x/tile, z/tile).
      uvs.push(
        a1x * invTile, a1z * invTile, b1x * invTile, b1z * invTile, a2x * invTile, a2z * invTile,
        a2x * invTile, a2z * invTile, b1x * invTile, b1z * invTile, b2x * invTile, b2z * invTile,
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals(); // all up, but keeps the standard material happy

  // M10 (t10b): dark wet-asphalt PBR set. `repeat: 1` — the tiling is already baked
  // into the world-space UVs above, so we must NOT double-tile. ROAD_COLOR stays
  // the tint/fallback (offline-safe). The set is library-owned; never disposed here.
  const material = makeStandardMaterial(TextureLibrary.get('road-asphalt', () => makeAsphaltSet()), {
    repeat: 1,
    color: ROAD_COLOR,
    roughness: 0.95,
    metalness: 0,
    normalScale: 0.5,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'roads';
  mesh.receiveShadow = true; // catch building / tree shadows raked across the street
  return mesh;
}

/* -------------------------------------------------------------------------- */
/* Forest floor — one flat annulus under the perimeter tree band                */
/* -------------------------------------------------------------------------- */

/**
 * Build the forest-floor blend (M10 · t10e): ONE flat {@link THREE.RingGeometry}
 * annulus laid on the XZ plane, from just inside the ring road ({@link TOWN_HALF})
 * out to the map edge (`half`), so the tree band reads as mossy needle-litter
 * instead of the town's bare dirt. It is a single draw call.
 *
 * RingGeometry's native UVs are radial and awkward to tile, so — exactly like the
 * road ribbon — we overwrite them with a planar world-space projection
 * (`x / TILE`, `z / TILE`); the material then uses `repeat: 1` (tiling is baked
 * in) and the litter grain lines up with the base ground at the same density. The
 * ring is rotated flat (like `main.ts`'s ground plane) and seated at
 * {@link FOREST_FLOOR_Y}, between the grid and the road ribbons, to avoid z-fight.
 * Its geometry + material are children of the environment group, so
 * {@link disposeEnvironment} frees them; the texture set is library-owned.
 */
function buildForestFloor(half: number): THREE.Mesh {
  const geometry = new THREE.RingGeometry(TOWN_HALF, half, 96, 1);
  geometry.rotateX(-Math.PI / 2); // lay flat on XZ (ring authored in XY)

  // Planar world-space UVs from each vertex's (x, z); after the rotate the ring's
  // own Y is ~0, so x/z are the world plane coordinates.
  const posAttr = geometry.getAttribute('position');
  const uv = new Float32Array(posAttr.count * 2);
  const invTile = 1 / FOREST_FLOOR_TILE_METERS;
  for (let i = 0; i < posAttr.count; i++) {
    uv[i * 2] = posAttr.getX(i) * invTile;
    uv[i * 2 + 1] = posAttr.getZ(i) * invTile;
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));

  const material = makeStandardMaterial(TextureLibrary.get('forest-floor', () => makeForestFloorSet()), {
    repeat: 1,
    color: FOREST_FLOOR_COLOR,
    roughness: 1,
    metalness: 0,
    normalScale: 0.8,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'forest-floor';
  mesh.position.y = FOREST_FLOOR_Y;
  mesh.receiveShadow = true; // trunk/canopy shadows fall onto the litter
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
 * Build the whole environment for `world` as one {@link THREE.Group}: the forest-
 * floor annulus, the forest (two instanced meshes), the merged road ribbon, and
 * the scatter props (two more instanced meshes) — ~6 draw calls total. The group
 * is returned (not added to a scene) so the caller owns insertion and, via
 * {@link disposeEnvironment}, cleanup.
 * All randomness is seeded from `world.seed`, so the result is identical per town.
 */
export function buildEnvironment(world: World): THREE.Group {
  const group = new THREE.Group();
  group.name = 'environment';

  // One PRNG stream for every client-side placement choice (foliage tint + scatter),
  // seeded from the world seed but offset so it never mirrors the shared streams.
  const rng = mulberry32((world.seed ^ 0x1b56c4e9) >>> 0);

  // Forest floor first (lowest, at FOREST_FLOOR_Y) so the road ribbons (higher, at
  // ROAD_Y) win the depth test where a street grazes the tree band.
  group.add(buildForestFloor(world.half));
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
