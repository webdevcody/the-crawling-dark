/**
 * The Crawling Dark — town renderer (M2 · t2a client view, M10 · t10c/t10d skin).
 *
 * Builds the visible town as Three.js box meshes directly from the shared,
 * seeded {@link World} data — the exact same {@link Building} list the
 * authoritative server collides players against. Because both sides derive the
 * town from one `mapSeed` (see the WELCOME message), what you see is precisely
 * what you collide with: no separate art data to drift out of sync.
 *
 * M9 (t9c) drops the bare perimeter wall slabs from the render: the dense
 * perimeter forest (see {@link scene/Environment}) now walls the map edge, so
 * drawing the old boundary boxes would only clip through the trees. The wall is
 * still enforced in shared collision — it is a position clamp, never a collider —
 * so hiding its meshes changes nothing about what the player runs into.
 *
 * ## M10 · t10c/t10d — facade + curtain-wall textures
 *
 * The boxes used to be flat `MeshStandardMaterial` colors. M10 skins them with
 * the procedural PBR pipeline in {@link scene/TextureLibrary} (offline-safe: no
 * network, everything generated on a canvas at load). Two building families:
 *
 *   - **t10c — low/mid facades**: brick / concrete albedo + normal + roughness,
 *     with dark recessed window panes and an **emissive lit-window map** so a
 *     scatter of windows glows warm sodium at night. This emissive read is the
 *     whole point — against the near-black fog the town is legible mainly by its
 *     lit windows, not its (deliberately dark) walls.
 *   - **t10d — glass towers**: buildings taller than {@link TOWER_MIN_HEIGHT}
 *     get a curtain-wall material — high metalness + low roughness for a glassy
 *     read, a fine mullion-grid normal, and a cooler white/blue emissive window
 *     grid so towers never read as flat black slabs against the sky. The
 *     threshold coordinates with the M9 · t9b district gradient (taller near the
 *     core), so glass towers cluster downtown and brick/concrete lines the rim.
 *
 * ## Per-building UV WITHOUT a per-mesh material explosion
 *
 * Both issues want window rows to tile per box AND one shared material per
 * variant. We get both by **baking the tiling into each box's UV attribute**
 * (see {@link bakeTiledUVs}) while sharing ONE material per variant across every
 * building of that variant. A box face's UVs are `[0,1]`; scaling them by the
 * building's meters/window count makes a single unit-cell texture tile to that
 * box, so the material's own `repeat` stays `1` and total materials are bounded
 * to `(# facade variants) + (# tower variants)` — never one per building.
 *
 * Variant look is picked deterministically by `b.id` (no `Math.random`); the
 * generators are seeded off the variant, so a regenerated town is identical.
 * Rendering only: collision still reads the AABB footprints and is untouched.
 */

import * as THREE from 'three';
import { buildingAABB, type Building, type World } from '@crawling-dark/shared';
import {
  TextureLibrary,
  makeStandardMaterial,
  makeAlbedoTexture,
  makeGrayscaleTexture,
  makeNormalTexture,
  fbm,
  mixRgb,
  type PBRTextureSet,
} from './TextureLibrary';

/** Deterministic, muted facade color from a building id (golden-ratio hue). */
function facadeColor(id: number): THREE.Color {
  const hue = (id * 0.61803398875) % 1;
  // Low saturation + low lightness keeps the town brooding and readable in fog.
  return new THREE.Color().setHSL(hue, 0.18, 0.34);
}

/** A perimeter wall slab spans the full map half-extent on one axis. */
function isPerimeterWall(b: Building, world: World): boolean {
  return b.hw >= world.half || b.hd >= world.half;
}

/* -------------------------------------------------------------------------- */
/* t10d — glass-tower threshold                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Buildings at least this tall (meters) render as **glass curtain-wall towers**
 * (t10d); everything shorter is a brick/concrete facade (t10c). The world's
 * t9b district gradient makes core blocks 16–44 m and rim blocks 3.5–8 m tall,
 * so a threshold of 18 m cleanly picks the downtown cluster (a minority of all
 * buildings) as glass towers while leaving the rim — and the shortest core
 * mid-rises — as textured facades. Tune with the gradient, not in isolation.
 */
const TOWER_MIN_HEIGHT = 18.0;

/* -------------------------------------------------------------------------- */
/* Texture resolutions (power-of-two, small — cached once by TextureLibrary)    */
/* -------------------------------------------------------------------------- */

const ALBEDO_SIZE = 256;
const EMISSIVE_SIZE = 256;
const NORMAL_SIZE = 128;
const ROUGH_SIZE = 128;

/* -------------------------------------------------------------------------- */
/* Small deterministic helpers                                                  */
/* -------------------------------------------------------------------------- */

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const fract = (x: number): number => x - Math.floor(x);

/** Integer hash → `[0, 1)`; the deterministic basis for lit-window choices. */
function hash01(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Deterministically decide whether window cell `(cx, cy)` is lit for `seed`. */
function litCell(cx: number, cy: number, seed: number, fraction: number): boolean {
  const key = (Math.imul(cx + 1, 73856093) ^ Math.imul(cy + 1, 19349663) ^ Math.imul(seed, 83492791)) | 0;
  return hash01(key) < fraction;
}

/** Which window cell (and whether inside its pane) a unit-square `(u, v)` hits. */
function windowCell(
  u: number,
  v: number,
  wx: number,
  wy: number,
  fx: number,
  fy: number,
): { cx: number; cy: number; inPane: boolean } {
  const su = u * wx;
  const sv = v * wy;
  const cx = Math.floor(su);
  const cy = Math.floor(sv);
  const lx = su - cx;
  const ly = sv - cy;
  const inPane = lx > fx && lx < 1 - fx && ly > fy && ly < 1 - fy;
  return { cx, cy, inPane };
}

/** `rgb(...)` CSS string from a 0xRRGGBB int scaled by `f` (default 1). */
function cssRgb(hex: number, f = 1): string {
  const r = Math.round(((hex >> 16) & 0xff) * f);
  const g = Math.round(((hex >> 8) & 0xff) * f);
  const b = Math.round((hex & 0xff) * f);
  return `rgb(${r},${g},${b})`;
}

/** `rgb(...)` CSS string from an `[r,g,b]` byte triple scaled by `f`. */
function cssRgbTriple(t: readonly [number, number, number], f = 1): string {
  return `rgb(${Math.round(t[0] * f)},${Math.round(t[1] * f)},${Math.round(t[2] * f)})`;
}

/* -------------------------------------------------------------------------- */
/* Variant specs — the bounded set of facade + tower looks                      */
/* -------------------------------------------------------------------------- */

/**
 * One building-skin variant. A spec fully describes a shared material + its
 * cached PBR/emissive textures, so `b.id % variants` picks a look without ever
 * minting a per-building material. `tileMetersX/Y` are the real-world size of
 * one texture tile (its `windowsX × windowsY` window grid), which drives the
 * baked per-building UV scaling in {@link bakeTiledUVs}.
 */
interface VariantSpec {
  /** Cache-name suffix + normal/albedo seed (kept unique per variant). */
  key: string;
  /** Albedo style — `glass` is the t10d curtain wall; others are t10c walls. */
  style: 'brick' | 'concrete' | 'glass';
  /** Meters spanned by one texture tile, horizontally / vertically. */
  tileMetersX: number;
  tileMetersY: number;
  /** Window cells per tile (the grid baked into every map). */
  windowsX: number;
  windowsY: number;
  /** Frame/mullion inset as a fraction of a cell (window pane is the remainder). */
  frameFracX: number;
  frameFracY: number;
  /** Wall/glass base tones (dark → light) blended by the surface noise. */
  baseDark: number;
  baseLight: number;
  /** Mortar (brick), seam (concrete) or mullion (glass) line color. */
  line: number;
  /** Unlit window-pane color (dark recessed glass). */
  glass: number;
  /** Brick sub-pattern density (brick style only). */
  brickRows?: number;
  brickCols?: number;
  /** Lit-window emissive color + how many cells light up + pattern seed. */
  litColor: number;
  litFraction: number;
  litSeed: number;
  /** `emissiveIntensity` for the shared material (dim = night, not neon). */
  emissiveIntensity: number;
  /** Material metalness (0 for walls, high for glass) + flat fallback roughness. */
  metalness: number;
  roughness: number;
  /** Roughness-map values: window pane vs. wall/mullion. */
  paneRough: number;
  frameRough: number;
  /** Height-field strength for the normal map + material normalScale. */
  normalGenStrength: number;
  normalScale: number;
  /** Flat color used when textures are unavailable (offline/headless path). */
  fallback: THREE.ColorRepresentation;
}

/**
 * t10c facades — two brick tones + one concrete. Walls stay deliberately dark
 * (night mood); the warm sodium `litColor` windows are what make them read.
 * Facade tiles are small (6 m × 4.4 m over a 2 × 2 window grid) so even a tiny
 * rim house resolves to a believable one/two-storey window arrangement while a
 * taller mid-rise tiles the same cell up its height.
 */
const FACADE_VARIANTS: readonly VariantSpec[] = [
  {
    key: 'facade-brick-a',
    style: 'brick',
    tileMetersX: 6,
    tileMetersY: 4.4,
    windowsX: 2,
    windowsY: 2,
    frameFracX: 0.26,
    frameFracY: 0.24,
    baseDark: 0x1b1310,
    baseLight: 0x352418,
    line: 0x14100d,
    glass: 0x0a0d12,
    brickRows: 20,
    brickCols: 10,
    litColor: 0xffcf94,
    litFraction: 0.4,
    litSeed: 11,
    emissiveIntensity: 1.0,
    metalness: 0,
    roughness: 0.9,
    paneRough: 0.42,
    frameRough: 0.92,
    normalGenStrength: 1.6,
    normalScale: 1.0,
    fallback: facadeColor(11).getHex(),
  },
  {
    key: 'facade-brick-b',
    style: 'brick',
    tileMetersX: 6,
    tileMetersY: 4.4,
    windowsX: 2,
    windowsY: 2,
    frameFracX: 0.27,
    frameFracY: 0.25,
    baseDark: 0x171614,
    baseLight: 0x2b2620,
    line: 0x100f0e,
    glass: 0x0a0c11,
    brickRows: 22,
    brickCols: 9,
    litColor: 0xffb976,
    litFraction: 0.3,
    litSeed: 29,
    emissiveIntensity: 0.9,
    metalness: 0,
    roughness: 0.9,
    paneRough: 0.44,
    frameRough: 0.92,
    normalGenStrength: 1.6,
    normalScale: 1.0,
    fallback: facadeColor(29).getHex(),
  },
  {
    key: 'facade-concrete',
    style: 'concrete',
    tileMetersX: 6,
    tileMetersY: 4.4,
    windowsX: 2,
    windowsY: 2,
    frameFracX: 0.24,
    frameFracY: 0.22,
    baseDark: 0x1a1c20,
    baseLight: 0x30343a,
    line: 0x121317,
    glass: 0x0b0e13,
    litColor: 0xffd9a6,
    litFraction: 0.34,
    litSeed: 47,
    emissiveIntensity: 0.85,
    metalness: 0,
    roughness: 0.88,
    paneRough: 0.4,
    frameRough: 0.9,
    normalGenStrength: 1.3,
    normalScale: 0.9,
    fallback: facadeColor(47).getHex(),
  },
];

/**
 * t10d glass towers — three curtain-wall tints (blue / steel-white / teal) with
 * different lit-window densities + intensities so towers aren't clones. High
 * metalness + low roughness give the glassy read; the emissive grid keeps them
 * from going flat-black. Tower tiles are larger (12 m × 13 m over a 4 × 4 grid)
 * so a skyscraper reads as many small offices, a scatter of them lit.
 */
const TOWER_VARIANTS: readonly VariantSpec[] = [
  {
    key: 'tower-blue',
    style: 'glass',
    tileMetersX: 12,
    tileMetersY: 13,
    windowsX: 4,
    windowsY: 4,
    frameFracX: 0.06,
    frameFracY: 0.05,
    baseDark: 0x0b1119,
    baseLight: 0x1a2634,
    line: 0x090d12,
    glass: 0x0e1622,
    litColor: 0xbfd4ff,
    litFraction: 0.26,
    litSeed: 101,
    emissiveIntensity: 1.1,
    metalness: 0.72,
    roughness: 0.22,
    paneRough: 0.16,
    frameRough: 0.5,
    normalGenStrength: 0.6,
    normalScale: 0.6,
    fallback: 0x121a26,
  },
  {
    key: 'tower-steel',
    style: 'glass',
    tileMetersX: 12,
    tileMetersY: 13,
    windowsX: 4,
    windowsY: 4,
    frameFracX: 0.05,
    frameFracY: 0.05,
    baseDark: 0x0a0f16,
    baseLight: 0x18222e,
    line: 0x080b10,
    glass: 0x0d141e,
    litColor: 0xd8e4ff,
    litFraction: 0.2,
    litSeed: 211,
    emissiveIntensity: 1.0,
    metalness: 0.82,
    roughness: 0.16,
    paneRough: 0.13,
    frameRough: 0.45,
    normalGenStrength: 0.55,
    normalScale: 0.55,
    fallback: 0x101722,
  },
  {
    key: 'tower-teal',
    style: 'glass',
    tileMetersX: 12,
    tileMetersY: 13,
    windowsX: 4,
    windowsY: 4,
    frameFracX: 0.06,
    frameFracY: 0.05,
    baseDark: 0x0a1512,
    baseLight: 0x162a26,
    line: 0x081210,
    glass: 0x0c1a18,
    litColor: 0xcdeaff,
    litFraction: 0.3,
    litSeed: 307,
    emissiveIntensity: 0.95,
    metalness: 0.68,
    roughness: 0.24,
    paneRough: 0.18,
    frameRough: 0.52,
    normalGenStrength: 0.6,
    normalScale: 0.6,
    fallback: 0x101b1c,
  },
];

/* -------------------------------------------------------------------------- */
/* Procedural map generators (one unit cell = one window grid, seamless-tiling) */
/* -------------------------------------------------------------------------- */

/**
 * Paint a variant's **albedo**: a brick/concrete wall (or glass curtain) as the
 * per-pixel base, then dark recessed window panes (walls) or a mullion grid
 * (glass) overlaid so the window layout lines up with the emissive/normal maps.
 * Everything is authored on the seamless `[0,1)` unit square so it tiles.
 */
function paintAlbedo(ctx: CanvasRenderingContext2D, size: number, spec: VariantSpec): void {
  const img = ctx.createImageData(size, size);
  const rows = spec.brickRows ?? 20;
  const cols = spec.brickCols ?? 10;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let col: readonly [number, number, number];
      if (spec.style === 'brick') {
        const course = Math.floor(v * rows);
        const offset = course % 2 === 0 ? 0 : 0.5;
        const bu = u * cols + offset;
        const brickId = Math.floor(bu) + course * 7;
        let t = 0.25 + 0.6 * hash01(brickId);
        t += (fbm(u, v, { basePeriod: 40, octaves: 2, seed: spec.litSeed }) - 0.5) * 0.25;
        col = mixRgb(spec.baseDark, spec.baseLight, clamp01(t));
        const my = fract(v * rows);
        const mx = fract(bu);
        if (my < 0.1 || my > 0.9 || mx < 0.07 || mx > 0.93) col = mixRgb(spec.line, spec.line, 0);
      } else if (spec.style === 'concrete') {
        let t = 0.3 + 0.5 * fbm(u, v, { basePeriod: 5, octaves: 4, seed: spec.litSeed });
        t += (fbm(u, v, { basePeriod: 64, octaves: 2, seed: spec.litSeed + 3 }) - 0.5) * 0.15;
        col = mixRgb(spec.baseDark, spec.baseLight, clamp01(t));
      } else {
        // Glass: a soft vertical gradient (a touch lighter low) + faint noise.
        const g = 0.35 + 0.4 * (1 - v) + 0.25 * fbm(u, v, { basePeriod: 6, octaves: 3, seed: spec.litSeed });
        col = mixRgb(spec.baseDark, spec.baseLight, clamp01(g));
      }
      const o = (y * size + x) * 4;
      img.data[o] = col[0];
      img.data[o + 1] = col[1];
      img.data[o + 2] = col[2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const cw = size / spec.windowsX;
  const ch = size / spec.windowsY;
  if (spec.style === 'glass') {
    // Curtain wall: draw a thin mullion grid over the glass. Lines sit on cell
    // boundaries (including 0 ≡ size) so the grid tiles seamlessly.
    ctx.fillStyle = cssRgb(spec.line);
    const tX = Math.max(1, cw * spec.frameFracX);
    const tY = Math.max(1, ch * spec.frameFracY);
    for (let i = 0; i <= spec.windowsX; i++) ctx.fillRect(i * cw - tX / 2, 0, tX, size);
    for (let j = 0; j <= spec.windowsY; j++) ctx.fillRect(0, j * ch - tY / 2, tY, size);
  } else {
    // Wall: recessed dark glass pane inside each cell's frame.
    ctx.fillStyle = cssRgb(spec.glass);
    for (let cy = 0; cy < spec.windowsY; cy++) {
      for (let cx = 0; cx < spec.windowsX; cx++) {
        const px0 = cx * cw + spec.frameFracX * cw;
        const py0 = cy * ch + spec.frameFracY * ch;
        ctx.fillRect(px0, py0, cw - 2 * spec.frameFracX * cw, ch - 2 * spec.frameFracY * ch);
      }
    }
  }
}

/**
 * The variant's PBR set (albedo + normal + roughness). The height field recesses
 * window panes (walls) or raises the mullion grid (glass) so the normal map's
 * relief matches the painted layout; roughness makes glass panes glossier than
 * their rough surrounds. Any map is `null` offline-safe → flat-color fallback.
 */
function makeFacadeSet(spec: VariantSpec): PBRTextureSet {
  const map = makeAlbedoTexture(ALBEDO_SIZE, (ctx, s) => paintAlbedo(ctx, s, spec));

  const height = (u: number, v: number): number => {
    const c = windowCell(u, v, spec.windowsX, spec.windowsY, spec.frameFracX, spec.frameFracY);
    if (spec.style === 'glass') {
      // Panes flat, mullion grid slightly proud → crisp mullion normals.
      return c.inPane ? 0.5 + 0.02 * fbm(u, v, { basePeriod: 16, octaves: 2, seed: spec.litSeed }) : 1.0;
    }
    // Wall: window pane sits back (0), wall surface stands proud with grain.
    if (c.inPane) return 0.0;
    return 0.7 + 0.3 * fbm(u, v, { basePeriod: 24, octaves: 2, seed: spec.litSeed });
  };
  const normalMap = makeNormalTexture(NORMAL_SIZE, height, spec.normalGenStrength);

  const roughnessMap = makeGrayscaleTexture(ROUGH_SIZE, (x, y) => {
    const c = windowCell(x / ROUGH_SIZE, y / ROUGH_SIZE, spec.windowsX, spec.windowsY, spec.frameFracX, spec.frameFracY);
    return c.inPane ? spec.paneRough : spec.frameRough;
  });

  return { map, normalMap, roughnessMap };
}

/**
 * Paint the **emissive lit-window** map: black everywhere except a deterministic
 * scatter of lit cells, each a soft radial glow in the variant's window color
 * (warm sodium for facades, cool white/blue for towers) with per-window
 * brightness jitter. Stored as an sRGB canvas (three reads `emissiveMap` as
 * color) and multiplied by a white `emissive` base × dim `emissiveIntensity`, so
 * it reads as scattered night windows rather than neon.
 */
function makeWindowEmissive(spec: VariantSpec): THREE.Texture | null {
  return makeAlbedoTexture(EMISSIVE_SIZE, (ctx, s) => {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, s, s);
    const cw = s / spec.windowsX;
    const ch = s / spec.windowsY;
    const core = mixRgb(spec.litColor, 0xffffff, 0.35);
    for (let cy = 0; cy < spec.windowsY; cy++) {
      for (let cx = 0; cx < spec.windowsX; cx++) {
        if (!litCell(cx, cy, spec.litSeed, spec.litFraction)) continue;
        const px0 = cx * cw + spec.frameFracX * cw;
        const py0 = cy * ch + spec.frameFracY * ch;
        const pw = cw - 2 * spec.frameFracX * cw;
        const ph = ch - 2 * spec.frameFracY * ch;
        if (pw <= 0 || ph <= 0) continue;
        const mx = px0 + pw / 2;
        const my = py0 + ph / 2;
        const f = 0.55 + 0.45 * hash01((Math.imul(cx + 1, 2654435761) ^ Math.imul(cy + 3, 40503) ^ spec.litSeed) | 0);
        const r1 = Math.hypot(pw, ph) / 2;
        const grad = ctx.createRadialGradient(mx, my, Math.max(0.5, r1 * 0.15), mx, my, r1);
        grad.addColorStop(0, cssRgbTriple(core, f));
        grad.addColorStop(0.7, cssRgb(spec.litColor, f));
        grad.addColorStop(1, cssRgb(spec.litColor, f * 0.55));
        ctx.fillStyle = grad;
        ctx.fillRect(px0, py0, pw, ph);
      }
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Shared variant materials                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build the ONE shared `MeshStandardMaterial` for a variant. Textures come from
 * {@link TextureLibrary.get} (memoized, so a variant's maps generate once and
 * persist across town regenerations); the material itself is minted fresh per
 * `buildTown` call so {@link disposeTown} can freely dispose it (that never
 * touches the library-owned shared textures). Tiling is baked into geometry UVs,
 * so material `repeat` stays 1. `color` is white when a real albedo exists (no
 * double-darkening the already-dark art) and the variant's muted fallback when
 * generation was unavailable — the offline flat-color path.
 */
function buildVariantMaterial(spec: VariantSpec): THREE.MeshStandardMaterial {
  const pbr = TextureLibrary.get(`town-${spec.key}`, () => makeFacadeSet(spec));
  const emissive = TextureLibrary.get(`town-${spec.key}-emissive`, () => ({
    map: makeWindowEmissive(spec),
    normalMap: null,
    roughnessMap: null,
  }));

  const extra: THREE.MeshStandardMaterialParameters = {};
  if (emissive.map !== null) {
    // White base × colored emissiveMap × dim intensity = the painted windows.
    extra.emissive = 0xffffff;
    extra.emissiveMap = emissive.map;
    extra.emissiveIntensity = spec.emissiveIntensity;
  }

  return makeStandardMaterial(pbr, {
    repeat: 1,
    color: pbr.map !== null ? 0xffffff : spec.fallback,
    // With a roughnessMap present the map is the truth (base 1 lets it through);
    // the flat `spec.roughness` only matters on the mapless offline path.
    roughness: pbr.roughnessMap !== null ? 1 : spec.roughness,
    metalness: spec.metalness,
    normalScale: spec.normalScale,
    extra,
  });
}

/* -------------------------------------------------------------------------- */
/* Per-building UV baking                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Scale a box's UV attribute so one texture tile maps to `tileMetersX/Y` of the
 * building, tiling the window grid up its walls. A default `BoxGeometry` has 24
 * UVs — 4 per face, faces ordered `+X,-X,+Y,-Y,+Z,-Z`. Side walls tile their
 * horizontal span (depth on ±X, width on ±Z) by the window-column count and
 * their height by the floor count, so windows stay roughly square on every wall;
 * the ±Y roof/floor tile too but are rarely seen (acceptable per t10c/t10d). The
 * texture's own `repeat` stays 1 — tiling lives here, in the geometry.
 */
function bakeTiledUVs(
  geometry: THREE.BoxGeometry,
  width: number,
  depth: number,
  height: number,
  tileMetersX: number,
  tileMetersY: number,
): void {
  const uv = geometry.getAttribute('uv');
  if (uv === undefined || uv.count < 24) return;
  const cW = Math.max(1, Math.round(width / tileMetersX));
  const cD = Math.max(1, Math.round(depth / tileMetersX));
  const cH = Math.max(1, Math.round(height / tileMetersY));
  // Per-face [uScale, vScale] in BoxGeometry face order.
  const faceScale: ReadonlyArray<readonly [number, number]> = [
    [cD, cH], // +X : spans depth × height
    [cD, cH], // -X
    [cW, cD], // +Y : spans width × depth (roof)
    [cW, cD], // -Y
    [cW, cH], // +Z : spans width × height
    [cW, cH], // -Z
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = faceScale[f];
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  }
  uv.needsUpdate = true;
}

/* -------------------------------------------------------------------------- */
/* Build / dispose                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a {@link THREE.Group} of building meshes for `world`. The group is
 * returned (not added to any scene) so the caller controls insertion and, if a
 * round ever regenerates the town, disposal via {@link disposeTown}.
 *
 * Each real building picks a variant by `b.id` (glass tower if it clears
 * {@link TOWER_MIN_HEIGHT}, else a facade) and shares that variant's ONE
 * material — materials are minted lazily on first use, so the count is bounded
 * to the variants actually present and every minted material is attached to a
 * mesh (hence disposed exactly once). Per-building window tiling comes from
 * baking the box UVs (see {@link bakeTiledUVs}); collision is untouched.
 */
export function buildTown(world: World): THREE.Group {
  const group = new THREE.Group();
  group.name = 'town';

  // Lazily-minted shared variant materials (index parallels the spec arrays).
  const facadeMats: Array<THREE.MeshStandardMaterial | null> = FACADE_VARIANTS.map(() => null);
  const towerMats: Array<THREE.MeshStandardMaterial | null> = TOWER_VARIANTS.map(() => null);

  // Probe once whether procedural textures are available (a 2D canvas exists).
  // If not (headless/offline), fall back to the original per-building muted
  // flat-color path so the town still reads with zero textures.
  const texturesReady = TextureLibrary.get(`town-${FACADE_VARIANTS[0].key}`, () => makeFacadeSet(FACADE_VARIANTS[0])).map !== null;

  for (const b of world.buildings) {
    // M9 (t9c): the perimeter is now a wall of forest, so the bare boundary
    // slabs are no longer drawn — skip them (collision is unchanged, the wall
    // being a clamp in shared, not a mesh). Every real building still renders.
    if (isPerimeterWall(b, world)) continue;

    const aabb = buildingAABB(b);
    const width = aabb.maxX - aabb.minX;
    const depth = aabb.maxZ - aabb.minZ;
    const geometry = new THREE.BoxGeometry(width, b.height, depth);

    let material: THREE.MeshStandardMaterial;
    if (texturesReady) {
      const isTower = b.height >= TOWER_MIN_HEIGHT;
      const specs = isTower ? TOWER_VARIANTS : FACADE_VARIANTS;
      const mats = isTower ? towerMats : facadeMats;
      const vi = ((b.id % specs.length) + specs.length) % specs.length;
      const spec = specs[vi];
      // Bake per-building window tiling into the geometry UVs (shared material).
      bakeTiledUVs(geometry, width, depth, b.height, spec.tileMetersX, spec.tileMetersY);
      mats[vi] ??= buildVariantMaterial(spec);
      material = mats[vi] as THREE.MeshStandardMaterial;
    } else {
      // Offline/headless: original muted per-building facade (no textures).
      material = new THREE.MeshStandardMaterial({
        color: facadeColor(b.id),
        roughness: 0.9,
        metalness: 0,
      });
    }

    const mesh = new THREE.Mesh(geometry, material);
    // Box origin is centered; lift by half the height so the base sits on y = 0.
    mesh.position.set(b.cx, b.height / 2, b.cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return group;
}

/**
 * Dispose every geometry/material under a town group (call before dropping it).
 * Materials are deduped by identity, so each shared variant material is disposed
 * once. Shared PBR/emissive **textures are owned by {@link TextureLibrary}** and
 * are intentionally NOT disposed here (a `MeshStandardMaterial.dispose()` never
 * touches its textures) — they persist across town regenerations by design.
 */
export function disposeTown(group: THREE.Group): void {
  const seenMaterials = new Set<THREE.Material>();
  for (const child of group.children) {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const mat = child.material as THREE.Material;
      if (!seenMaterials.has(mat)) {
        seenMaterials.add(mat);
        mat.dispose();
      }
    }
  }
}
