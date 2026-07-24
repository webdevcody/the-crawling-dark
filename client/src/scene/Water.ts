/**
 * The Crawling Dark — the lake surface (M9 · t9d client).
 *
 * Renders {@link World.water} as a single animated water disc that fits the dark,
 * foggy night of {@link scene/Atmosphere}. The look is deliberately subtle: a very
 * dark, semi-metallic surface (so the cold moon key-light reads as a faint sheen
 * rather than a bright mirror) whose ripples come entirely from a small,
 * procedural, seamlessly-tiling NORMAL map that is slowly scrolled every frame.
 * Perturbing the surface normals — not the vertices — is what makes the water
 * shimmer under the moon without any geometry churn, so {@link Water.update} is a
 * couple of scalar writes with ZERO per-frame allocations.
 *
 * The disc sits a hair above the ground plane (see {@link WATER_Y}) so it never
 * z-fights the ground (`y = 0`) or the debug grid (`y = 0.01`). It is one mesh,
 * hence one draw call, and owns its geometry / material / texture so the caller
 * can drop it cleanly via {@link Water.dispose}.
 */

import * as THREE from 'three';
import type { Lake } from '@crawling-dark/shared';

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/** Height (meters) of the surface above `y = 0` — clears the ground and the grid. */
const WATER_Y = 0.03;

/** Deep, cold night-water tint. Kept very dark so it melts into the fog like everything else. */
const WATER_COLOR = 0x0a1622;

/**
 * Surface finish. Low `roughness` + moderate `metalness` gives a wet, reflective
 * sheen where the moon rakes across it, while the near-black {@link WATER_COLOR}
 * keeps the body of the lake dark. Slightly transparent so the shore reads as
 * water depth rather than a flat lid.
 */
const WATER_ROUGHNESS = 0.22;
const WATER_METALNESS = 0.55;
const WATER_OPACITY = 0.88;

/** Ripple normal strength — small, so the shimmer stays a gentle glimmer, never choppy. */
const NORMAL_SCALE = 0.35;

/**
 * Procedural normal-map resolution (per side) and how many world-meters one tile
 * spans. The map tiles seamlessly (integer wave frequencies), so it can repeat
 * across the disc as often as `radius / TILE_METERS` without a visible seam.
 */
const NORMAL_TEX_SIZE = 64;
const TILE_METERS = 4;

/** UV scroll speed (tiles per second) on each axis — a slow, diagonal drift. */
const SCROLL_U_PER_SEC = 0.015;
const SCROLL_V_PER_SEC = 0.02;

/* -------------------------------------------------------------------------- */
/* Procedural ripple normal map                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build a small, seamlessly-tiling tangent-space normal map for the ripples. The
 * height field is a sum of a few sine waves at INTEGER frequencies over the
 * texture, so opposite edges match and the map can repeat with no seam; the
 * per-texel normal is the analytic gradient of that field, encoded to the usual
 * `xyz → rgb` (`[-1,1] → [0,1]`) normal-map convention. Built once at construction
 * (never per frame). No color-space conversion is wanted — normal data is linear —
 * and three's {@link THREE.DataTexture} default (`NoColorSpace`) is already that.
 */
function makeRippleNormalTexture(): THREE.DataTexture {
  const n = NORMAL_TEX_SIZE;
  const data = new Uint8Array(n * n * 4);

  // A couple of octaves of directional ripples; integer freqs keep the tile seamless.
  const waves: ReadonlyArray<readonly [number, number, number]> = [
    // [freqU, freqV, amplitude]
    [1, 2, 0.6],
    [3, 1, 0.3],
    [2, 3, 0.2],
  ];

  const height = (u: number, v: number): number => {
    let h = 0;
    for (const [fu, fv, amp] of waves) {
      h += amp * Math.sin(2 * Math.PI * (fu * u + fv * v));
    }
    return h;
  };

  const eps = 1 / n; // one texel, for the central-difference gradient
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const v = j / n;
      // Analytic-ish gradient via wrapped central differences → tangent-space normal.
      const dhdu = (height(u + eps, v) - height(u - eps, v)) / (2 * eps);
      const dhdv = (height(u, v + eps) - height(u, v - eps)) / (2 * eps);
      // Normal of the height field: (-∂h/∂u, -∂h/∂v, 1), normalized.
      let nx = -dhdu;
      let ny = -dhdv;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      const nzn = nz * inv;

      const o = (j * n + i) * 4;
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nzn * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* -------------------------------------------------------------------------- */
/* Water surface                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The animated lake surface. Construct with the world's {@link Lake}, add
 * {@link Water.mesh} to the scene, call {@link Water.update} once per render frame
 * with the frame delta (ms), and {@link Water.dispose} on teardown.
 */
export class Water {
  /** The single disc mesh (one draw call) — add this to the scene. */
  readonly mesh: THREE.Mesh;

  private readonly geometry: THREE.CircleGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly normalMap: THREE.DataTexture;

  constructor(lake: Lake) {
    this.normalMap = makeRippleNormalTexture();
    // Repeat the ripple tile enough times to keep detail crisp on a big lake, but
    // at least twice so even the smallest lake shows more than one wave.
    const repeat = Math.max(2, Math.round(lake.radius / TILE_METERS));
    this.normalMap.repeat.set(repeat, repeat);

    // A disc, not a square, so the surface never pokes past the round shoreline.
    this.geometry = new THREE.CircleGeometry(lake.radius, 64);
    this.material = new THREE.MeshStandardMaterial({
      color: WATER_COLOR,
      roughness: WATER_ROUGHNESS,
      metalness: WATER_METALNESS,
      normalMap: this.normalMap,
      normalScale: new THREE.Vector2(NORMAL_SCALE, NORMAL_SCALE),
      transparent: true,
      opacity: WATER_OPACITY,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'water';
    // Lay the disc flat (it is authored in the XY plane) and seat it in the lake.
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(lake.cx, WATER_Y, lake.cz);
    // Flat water neither casts nor receives the moon's shadow — keep it clean.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /**
   * Advance the ripples by `dtMs` milliseconds. Scrolling the normal map's UV
   * offset makes the surface shimmer under the moon; three folds the offset into
   * the texture matrix at render time, so this is just two scalar adds — no
   * allocation, no geometry or texture re-upload.
   */
  update(dtMs: number): void {
    const dt = dtMs / 1000;
    this.normalMap.offset.x = (this.normalMap.offset.x + SCROLL_U_PER_SEC * dt) % 1;
    this.normalMap.offset.y = (this.normalMap.offset.y + SCROLL_V_PER_SEC * dt) % 1;
  }

  /** Dispose the surface's geometry, material, and ripple texture. */
  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.normalMap.dispose();
  }
}
