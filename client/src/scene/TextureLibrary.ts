/**
 * The Crawling Dark — PBR texture pipeline (M10 · t10a, the texture-pass prereq).
 *
 * Every surface in the town used to be a flat `MeshStandardMaterial` color
 * (`groundMaterial` in `main.ts`, `facadeColor()` in `TownView.ts`, the road /
 * forest palette in `Environment.ts`). M10 moves those onto real tiled PBR
 * materials, and this module is the pipeline that makes that possible.
 *
 * ## Offline-safe, procedural first — like the audio engine
 *
 * The audio pass ({@link audio/AudioEngine}) is *procedural Web Audio with no
 * bundled assets*: it always works, even with nothing to download. The texture
 * pass mirrors that philosophy. Rather than depend on fetching binary art at
 * runtime (which fails behind a firewall / offline), the maps here are
 * **generated procedurally at load time** — seamless fractal noise painted to a
 * canvas for albedo, an analytic tangent-space normal map derived from a height
 * field, and a grayscale roughness field. The generators are our own code, so
 * the resulting art is CC0-clean by construction (see
 * `client/public/textures/ATTRIBUTION.md`).
 *
 * A real file-loading path ({@link loadPBRSet}) is also provided so a curated
 * photo-scanned CC0 set (ambientCG / Poly Haven / Kenney) can be dropped into
 * `client/public/textures/**` to override a procedural default later — with the
 * SAME graceful fallback: a missing/failed map never breaks the boot, the
 * material just falls back to its flat base color.
 *
 * ## What "correct" means here
 *
 * three's color management (on by default in r152+) means the pipeline MUST tag
 * maps with the right color space or everything looks washed out / too dark:
 *   - **albedo** is authored in sRGB -> {@link THREE.SRGBColorSpace};
 *   - **normal** and **roughness** are linear data -> {@link THREE.NoColorSpace}.
 * Every map also gets {@link THREE.RepeatWrapping} + max anisotropy (captured
 * from the renderer via {@link TextureLibrary.init}) so tiled ground/roads stay
 * crisp at grazing angles and tile without a hard seam.
 *
 * ## Sharing without a per-mesh material explosion
 *
 * Generation is expensive-ish (a few 256-squared pixel loops), so every set is
 * cached by name through {@link TextureLibrary.get}. Consumers that need the
 * same look at a *different tile density* call {@link instanceSet}, which clones
 * the textures (independent `repeat`/`offset`) while **sharing the same GPU
 * upload** via three's `Texture.source` — so a hundred buildings can share one
 * brick image with per-building UV scaling and still cost one texture in VRAM.
 *
 * ## Later: KTX2 / Basis compression
 *
 * The procedural maps are small (<=256 squared) and cheap, so GPU-compressed
 * textures are unnecessary today. If a heavy photo set is later curated, wire a
 * `KTX2Loader` (three/examples/jsm/loaders/KTX2Loader) + `.transcoder` here and
 * have {@link loadPBRSet} prefer a `.ktx2` sibling when present — the public API
 * below does not change.
 */

import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A PBR material-map set. Any field may be `null` — a set with `map: null`
 * degrades gracefully to a flat-color material (see {@link makeStandardMaterial}),
 * which is the offline / missing-asset path.
 */
export interface PBRTextureSet {
  /** Albedo / base color, tagged {@link THREE.SRGBColorSpace}. */
  map: THREE.Texture | null;
  /** Tangent-space normal map (linear). */
  normalMap: THREE.Texture | null;
  /** Grayscale roughness map (linear); three reads its green channel. */
  roughnessMap: THREE.Texture | null;
}

/** Options for {@link makeStandardMaterial}. */
export interface StandardMaterialOptions {
  /** UV tiling; a scalar tiles both axes, a pair tiles `[u, v]` independently. */
  repeat?: number | readonly [number, number];
  /** Flat fallback color (used verbatim when `set.map` is `null`); also tints albedo. */
  color?: THREE.ColorRepresentation;
  roughness?: number;
  metalness?: number;
  /** Normal-map strength; `0` disables the normal contribution. */
  normalScale?: number;
  /** Extra {@link THREE.MeshStandardMaterialParameters} merged in last (emissive, etc.). */
  extra?: THREE.MeshStandardMaterialParameters;
}

/* -------------------------------------------------------------------------- */
/* Renderer-derived state (anisotropy)                                          */
/* -------------------------------------------------------------------------- */

/** Max anisotropy the GPU supports; captured in {@link TextureLibrary.init}. */
let maxAnisotropy = 4;

/* -------------------------------------------------------------------------- */
/* Seamless fractal value noise                                                 */
/* -------------------------------------------------------------------------- */

/** Smoothstep (3t^2 - 2t^3) — C1-continuous interpolation for value noise. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Hash a wrapped lattice cell `(ix, iy)` (period `p`) + `seed` to `[0, 1)`. */
function latticeHash(ix: number, iy: number, p: number, seed: number): number {
  const x = ((ix % p) + p) % p;
  const y = ((iy % p) + p) % p;
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}

/**
 * Seamlessly-tiling value noise sampled at `(u, v)` in `[0, 1)`, where the
 * lattice wraps every `period` cells. Because `u,v = 0` and `u,v = 1` map to the
 * same wrapped lattice cell, the resulting image tiles with no seam — the same
 * trick the water ripple map uses, generalized to a hashed lattice.
 */
function valueNoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period;
  const y = v * period;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const v00 = latticeHash(ix, iy, period, seed);
  const v10 = latticeHash(ix + 1, iy, period, seed);
  const v01 = latticeHash(ix, iy + 1, period, seed);
  const v11 = latticeHash(ix + 1, iy + 1, period, seed);
  const top = v00 + (v10 - v00) * fx;
  const bot = v01 + (v11 - v01) * fx;
  return top + (bot - top) * fy;
}

/** Parameters for {@link fbm} — a seamless fractal-Brownian-motion sampler. */
export interface FbmOptions {
  /** Lattice period of the coarsest octave (must be an integer to tile). */
  basePeriod?: number;
  /** Number of octaves; each doubles the period and halves the amplitude. */
  octaves?: number;
  /** Amplitude falloff per octave. */
  gain?: number;
  /** Noise seed. */
  seed?: number;
}

/**
 * Seamlessly-tiling fractal noise at `(u, v)` in `[0, 1)`, normalized to
 * roughly `[0, 1]`. Every octave uses an integer lattice period (`basePeriod`,
 * x2, x4, ...), so the whole sum tiles across the unit square — safe to paint
 * into a {@link THREE.RepeatWrapping} texture. Exported so each surface's
 * generator (dirt, asphalt, brick, bark, ...) can share one well-behaved noise
 * basis.
 */
export function fbm(u: number, v: number, opts: FbmOptions = {}): number {
  const basePeriod = opts.basePeriod ?? 4;
  const octaves = opts.octaves ?? 5;
  const gain = opts.gain ?? 0.5;
  const seed = opts.seed ?? 1;
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u, v, period, seed + o * 101);
    norm += amp;
    amp *= gain;
    period *= 2;
  }
  return sum / norm;
}

/* -------------------------------------------------------------------------- */
/* Texture builders (the primitives every consumer uses)                        */
/* -------------------------------------------------------------------------- */

/** A `<canvas>` + its 2D context, or `null` when 2D canvas is unavailable. */
function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  return { canvas, ctx };
}

/**
 * Tag + tune a texture for tiled surface use: color space, {@link
 * THREE.RepeatWrapping} on both axes, max anisotropy, and the given tile
 * `repeat`. Shared by every builder so wrapping/anisotropy are never forgotten.
 */
function tune(
  tex: THREE.Texture,
  colorSpace: THREE.ColorSpace,
  repeat: number | readonly [number, number],
): THREE.Texture {
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAnisotropy;
  const [rx, ry] = typeof repeat === 'number' ? [repeat, repeat] : repeat;
  tex.repeat.set(rx, ry);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Paint an **albedo** texture: call `painter(ctx, size)` to draw into a
 * `size`-squared canvas, then wrap it as an sRGB {@link THREE.CanvasTexture}.
 * Returns `null` if a 2D context can't be had (headless / offline-safe
 * fallback), so the caller degrades to a flat color. `size` should be a power of
 * two for clean mipmaps.
 */
export function makeAlbedoTexture(
  size: number,
  painter: (ctx: CanvasRenderingContext2D, size: number) => void,
  repeat: number | readonly [number, number] = 1,
): THREE.CanvasTexture | null {
  const made = makeCanvas(size);
  if (made === null) return null;
  painter(made.ctx, size);
  return tune(new THREE.CanvasTexture(made.canvas), THREE.SRGBColorSpace, repeat) as THREE.CanvasTexture;
}

/**
 * Build a **grayscale linear** texture (roughness / AO / an emissive mask) from
 * a per-texel field `value(x, y)` returning `[0, 1]`. Tagged {@link
 * THREE.NoColorSpace} (linear data, not color). Returns `null` offline-safe.
 */
export function makeGrayscaleTexture(
  size: number,
  value: (x: number, y: number) => number,
  repeat: number | readonly [number, number] = 1,
): THREE.DataTexture | null {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const g = Math.max(0, Math.min(255, Math.round(value(x, y) * 255)));
      const o = (y * size + x) * 4;
      data[o] = g;
      data[o + 1] = g;
      data[o + 2] = g;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tune(tex, THREE.NoColorSpace, repeat) as THREE.DataTexture;
}

/**
 * Derive a seamless tangent-space **normal map** from a height field
 * `height(u, v)` sampled over the unit square (both arguments wrap). Uses wrapped
 * central differences — exactly the technique in {@link scene/Water} — so the
 * normal map tiles with the albedo. `strength` scales the surface slope; larger
 * = bumpier. Encoded `xyz -> rgb` (`[-1,1] -> [0,1]`), tagged linear. Returns
 * `null` offline-safe.
 */
export function makeNormalTexture(
  size: number,
  height: (u: number, v: number) => number,
  strength = 1,
  repeat: number | readonly [number, number] = 1,
): THREE.DataTexture | null {
  const data = new Uint8Array(size * size * 4);
  const eps = 1 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      // Wrapped central differences -> the analytic gradient of the height field.
      const dhdu = (height(u + eps, v) - height(u - eps, v)) / (2 * eps);
      const dhdv = (height(u, v + eps) - height(u, v - eps)) / (2 * eps);
      let nx = -dhdu * strength;
      let ny = -dhdv * strength;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      const nzn = nz * inv;
      const o = (j * size + i) * 4;
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nzn * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tune(tex, THREE.NoColorSpace, repeat) as THREE.DataTexture;
}

/* -------------------------------------------------------------------------- */
/* Material helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build a {@link THREE.MeshStandardMaterial} from a {@link PBRTextureSet},
 * applying `repeat` to every present map. When `set` is `null` or has no albedo
 * (`map === null`) the material is a plain flat-color `color` — the graceful,
 * offline-safe fallback that keeps the town readable with zero textures. `extra`
 * (emissive maps, transparency, ...) is merged last so callers can specialize.
 */
export function makeStandardMaterial(
  set: PBRTextureSet | null,
  opts: StandardMaterialOptions = {},
): THREE.MeshStandardMaterial {
  const repeat = opts.repeat ?? 1;
  const applyRepeat = (tex: THREE.Texture | null): THREE.Texture | null => {
    if (tex === null) return null;
    const [rx, ry] = typeof repeat === 'number' ? [repeat, repeat] : repeat;
    tex.repeat.set(rx, ry);
    return tex;
  };

  const params: THREE.MeshStandardMaterialParameters = {
    color: opts.color ?? 0xffffff,
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? 0,
  };

  if (set !== null && set.map !== null) {
    params.map = applyRepeat(set.map) ?? undefined;
    if (set.normalMap !== null) {
      params.normalMap = applyRepeat(set.normalMap) ?? undefined;
      const ns = opts.normalScale ?? 1;
      params.normalScale = new THREE.Vector2(ns, ns);
    }
    if (set.roughnessMap !== null) params.roughnessMap = applyRepeat(set.roughnessMap) ?? undefined;
  }

  return new THREE.MeshStandardMaterial({ ...params, ...opts.extra });
}

/**
 * Clone a {@link PBRTextureSet} with an independent tile `repeat`. The clones
 * share the original's GPU upload (three keys VRAM by `Texture.source`), so many
 * surfaces can reuse one generated image at different densities without a
 * per-surface texture in memory. Use this when the SAME look needs different UV
 * scaling per object (e.g. per-building facade tiling).
 */
export function instanceSet(set: PBRTextureSet, repeatX: number, repeatY = repeatX): PBRTextureSet {
  const cloneWith = (tex: THREE.Texture | null): THREE.Texture | null => {
    if (tex === null) return null;
    const c = tex.clone();
    c.wrapS = THREE.RepeatWrapping;
    c.wrapT = THREE.RepeatWrapping;
    c.repeat.set(repeatX, repeatY);
    c.needsUpdate = true;
    return c;
  };
  return {
    map: cloneWith(set.map),
    normalMap: cloneWith(set.normalMap),
    roughnessMap: cloneWith(set.roughnessMap),
  };
}

/* -------------------------------------------------------------------------- */
/* File-loading path (curated CC0 override; offline-safe)                        */
/* -------------------------------------------------------------------------- */

/** URLs for a curated on-disk PBR set (any field optional). */
export interface PBRSetUrls {
  map?: string;
  normalMap?: string;
  roughnessMap?: string;
}

const loader = new THREE.TextureLoader();

/**
 * Load a curated CC0 set from `client/public/textures/**`, tagging color spaces
 * and wrapping exactly like the procedural path. Every map loads independently
 * and **fails soft**: a missing/blocked file resolves to `null` for that map
 * (never rejects), so a partial or fully-absent set still boots — the missing
 * maps just fall back to the flat color in {@link makeStandardMaterial}. This is
 * the seam for dropping photo-scanned art in later without touching consumers.
 */
export async function loadPBRSet(
  urls: PBRSetUrls,
  repeat: number | readonly [number, number] = 1,
): Promise<PBRTextureSet> {
  const load = (url: string | undefined, colorSpace: THREE.ColorSpace): Promise<THREE.Texture | null> => {
    if (url === undefined) return Promise.resolve(null);
    return loader
      .loadAsync(url)
      .then((tex) => tune(tex, colorSpace, repeat))
      .catch(() => null);
  };
  const [map, normalMap, roughnessMap] = await Promise.all([
    load(urls.map, THREE.SRGBColorSpace),
    load(urls.normalMap, THREE.NoColorSpace),
    load(urls.roughnessMap, THREE.NoColorSpace),
  ]);
  return { map, normalMap, roughnessMap };
}

/* -------------------------------------------------------------------------- */
/* The library — init + named cache                                             */
/* -------------------------------------------------------------------------- */

const cache = new Map<string, PBRTextureSet>();

/**
 * The shared texture library: a small, offline-safe facade over the builders
 * above with a name->set cache so an expensive generator runs at most once.
 */
export const TextureLibrary = {
  /**
   * Capture renderer-dependent state (max anisotropy). Call ONCE right after the
   * `WebGLRenderer` is constructed, before any world/material is built. Safe to
   * call again (idempotent); if never called, a conservative anisotropy of 4 is
   * used so materials still work.
   */
  init(renderer: THREE.WebGLRenderer): void {
    try {
      maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    } catch {
      // Leave the default; a broken capabilities probe must not break boot.
      maxAnisotropy = 4;
    }
  },

  /** The GPU's max anisotropy (post-{@link init}); useful for one-off textures. */
  get maxAnisotropy(): number {
    return maxAnisotropy;
  },

  /**
   * Memoized set access: returns the cached set for `name`, else runs `factory`
   * once and caches it. The `factory` is wrapped so a thrown generator (e.g. no
   * canvas) yields an all-`null` set rather than crashing the caller — the
   * offline-safe contract every consumer relies on.
   */
  get(name: string, factory: () => PBRTextureSet): PBRTextureSet {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    let set: PBRTextureSet;
    try {
      set = factory();
    } catch {
      set = { map: null, normalMap: null, roughnessMap: null };
    }
    cache.set(name, set);
    return set;
  },

  /** True if `name` is already generated + cached. */
  has(name: string): boolean {
    return cache.has(name);
  },

  /**
   * Dispose every cached texture and clear the cache. Intended for a full
   * teardown; per-object clones from {@link instanceSet} are owned/disposed by
   * their materials (see `disposeTown` / `disposeEnvironment`).
   */
  dispose(): void {
    for (const set of cache.values()) {
      set.map?.dispose();
      set.normalMap?.dispose();
      set.roughnessMap?.dispose();
    }
    cache.clear();
  },
};

/* -------------------------------------------------------------------------- */
/* Built-in generators (the ground demo + a shared basis for the town)          */
/* -------------------------------------------------------------------------- */

/** Linear-interpolate two 0xRRGGBB colors by `t` (0 -> a, 1 -> b) into [r,g,b] bytes. */
export function mixRgb(a: number, b: number, t: number): [number, number, number] {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return [
    Math.round(ar + (br - ar) * t),
    Math.round(ag + (bg - ag) * t),
    Math.round(ab + (bb - ab) * t),
  ];
}

/**
 * Generate a tiling dirt/earth PBR set for the ground plane — the M10 · t10a
 * demo surface (and the base of the M10 · t10b ground work). Low-frequency
 * blotches of damp earth over a fine grain, a matching bump-normal, and a
 * roughness field that dampens the darker (wetter) patches. All seamless.
 *
 * @param size texture resolution (power of two)
 */
export function makeGroundDirtSet(size = 256): PBRTextureSet {
  const seed = 1337;
  // Deep, cold, damp earth — sits under the near-black night fog of Atmosphere.
  const DARK = 0x0f1620;
  const LIGHT = 0x24303c;

  const map = makeAlbedoTexture(size, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const u = x / s;
        const v = y / s;
        // Big damp patches + a fine grain break-up.
        const blotch = fbm(u, v, { basePeriod: 3, octaves: 4, seed });
        const grain = fbm(u, v, { basePeriod: 24, octaves: 3, seed: seed + 7 });
        const t = Math.min(1, Math.max(0, blotch * 0.85 + grain * 0.25 - 0.05));
        const [r, g, b] = mixRgb(DARK, LIGHT, t);
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
    fbm(u, v, { basePeriod: 24, octaves: 3, seed: seed + 7 }) * 0.6 +
    fbm(u, v, { basePeriod: 6, octaves: 3, seed }) * 0.4;

  const normalMap = makeNormalTexture(size, heightAt, 1.4);
  const roughnessMap = makeGrayscaleTexture(size, (x, y) => {
    // Wetter (darker albedo) -> smoother; keep it broadly matte (0.75-0.98).
    const t = fbm(x / size, y / size, { basePeriod: 3, octaves: 4, seed });
    return 0.98 - t * 0.23;
  });

  return { map, normalMap, roughnessMap };
}
