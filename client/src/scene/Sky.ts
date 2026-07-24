/**
 * The Crawling Dark — night sky pass (M11 · t11a skydome + starfield, t11b moon).
 *
 * Replaces the flat near-black {@link scene/Atmosphere} background with a real
 * night sky, without touching the fog (which Atmosphere still owns). Three
 * concerns live here, all bundled into one {@link THREE.Group} the caller adds
 * once, right after {@link createAtmosphere}:
 *
 *   - {@link makeDome} — a large inverted (`BackSide`) sphere whose custom
 *     shader lerps a vertical GRADIENT from the exact fog near-black at the
 *     horizon up to a deep blue overhead. The bottom color is *identical* to the
 *     fog color so the distant town, dissolving into fog, blends into the horizon
 *     with NO visible seam. The dome opts out of fog (`fog: false`) and never
 *     writes depth, so real geometry always draws over it.
 *   - {@link makeStars} — a deterministic {@link THREE.Points} starfield. A
 *     fixed-seed {@link mulberry32} PRNG (never `Math.random`) means the exact
 *     same stars appear in the exact same places on every run; per-star size and
 *     brightness vary, and a cheap self-contained twinkle animates from
 *     `onBeforeRender` (no wiring into `main.ts`'s animate loop).
 *   - {@link makeMoon} — a billboarded {@link THREE.Sprite} disc with a soft
 *     additive halo, placed on the dome ALONG {@link MOON_LIGHT_POSITION} (the
 *     single source of truth for the moon light's direction), so the glowing
 *     source and the shadows the moon light casts point the same way. It glows
 *     softly through the fog (`fog: false`) but is kept dim enough not to wash
 *     out the stars.
 *
 * Color management: the renderer outputs sRGB with no tone mapping (defaults),
 * so the custom shaders end by encoding their linear working color through the
 * stock `<tonemapping_fragment>` + `<colorspace_fragment>` chunks — exactly the
 * path the town's `MeshStandardMaterial` takes. That is what guarantees the
 * dome's horizon and the fog resolve to the *same* on-screen pixels.
 */

import * as THREE from 'three';
import { MAP_SIZE } from '@crawling-dark/shared';
import { MOON_LIGHT_POSITION, DARK } from './Atmosphere';

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Skydome radius in meters. The camera far plane is 1000 (`main.ts`) and the
 * play area is only ±64, so a 900 m dome centered at the origin always fully
 * surrounds the camera while staying comfortably inside the far plane.
 */
const DOME_RADIUS = 900;

/**
 * Horizon (bottom) color of the sky gradient: the shared {@link DARK} fog color
 * imported straight from Atmosphere (M11 · t11e), so the town fading into fog
 * dissolves into the horizon with no seam and the two can never drift apart.
 */
const SKY_HORIZON_COLOR = DARK;

/** Zenith (overhead) color — a cold, deep midnight blue the gradient climbs to. */
const SKY_ZENITH_COLOR = 0x0a1a3a;

/**
 * Gradient shaping exponent applied to `max(dir.y, 0)`. Slightly > 1 keeps the
 * sky dark low near the horizon and concentrates the blue overhead, which reads
 * more like a real night sky than a straight linear ramp.
 */
const SKY_GRADIENT_POWER = 1.15;

/** How many stars to scatter across the (mostly upper) dome. */
const STAR_COUNT = 1500;

/**
 * Fixed PRNG seed for the starfield. A constant (never time / `Math.random`), so
 * star placement, size, color and twinkle phase are byte-for-byte identical on
 * every run — a hard requirement of t11a.
 */
const STAR_SEED = 0x9e3779b9;

/** Stars sit just inside the dome so they never z-fight or poke through it. */
const STAR_RADIUS_FRAC = 0.985;

/**
 * Lowest `dir.y` a star may take. Biased upward (mostly above the horizon) with
 * a small negative floor so a few sit right at the horizon for depth.
 */
const STAR_MIN_Y = -0.06;

/** Per-star point size range, in device-independent pixels (before pixel ratio). */
const STAR_MIN_PX = 1.0;
const STAR_MAX_PX = 3.2;

/** Size distribution bias: `pow(rng, BIAS)` makes most stars small, a few large. */
const STAR_SIZE_BIAS = 3.0;

/** Dimmest a star may be (as a fraction of full brightness). */
const STAR_BRIGHT_MIN = 0.45;

/** Twinkle animation: angular speed (rad/s) and brightness swing (± fraction). */
const TWINKLE_SPEED = 1.6;
const TWINKLE_AMOUNT = 0.18;

/** Where the moon sits along its light direction, as a fraction of the dome. */
const MOON_POS_FRAC = 0.95;

/** Moon sprite world sizes (meters at the dome). Disc reads as a crisp disc; the
 * halo is a broad, faint bloom behind it. */
const MOON_DISC_SIZE = 48;
const MOON_HALO_SIZE = 130;

/** Radial-gradient canvas resolution (per side) for the moon disc and halo. */
const MOON_TEX_SIZE = 128;

/* -------------------------------------------------------------------------- */
/* Deterministic PRNG                                                          */
/* -------------------------------------------------------------------------- */

/**
 * mulberry32 — the same tiny deterministic PRNG the world generator and
 * {@link scene/Environment} use, copied inline (never `Math.random`) so the
 * starfield is reproducible from {@link STAR_SEED} on every client, every run.
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
/* Skydome                                                                     */
/* -------------------------------------------------------------------------- */

/** Vertex shader: pass the (origin-centered) view direction to the fragment. */
const DOME_VERTEX = `
  varying vec3 vDir;
  void main() {
    // The dome is a sphere centered on the group origin, so the normalized
    // vertex position IS the direction from the viewer's world position to this
    // patch of sky (viewer stays effectively at the center at this scale).
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Fragment shader: lerp horizon -> zenith by `dir.y`. Everything at or below the
 * horizon is exactly the horizon color (== fog color) for a seamless join, then
 * it climbs to the zenith color overhead. Ends on the stock tone-map + color
 * space chunks so the output matches the rest of the scene's encoding.
 */
const DOME_FRAGMENT = `
  uniform vec3 uHorizonColor;
  uniform vec3 uZenithColor;
  uniform float uGradientPower;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, 0.0, 1.0);
    float t = pow(h, uGradientPower);
    vec3 col = mix(uHorizonColor, uZenithColor, t);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Build the gradient skydome: a large `BackSide` sphere with a custom
 * {@link THREE.ShaderMaterial}. It draws first (`renderOrder = -1`) and never
 * writes depth, so all real geometry paints over it; it opts out of fog so the
 * gradient itself is never fogged (the fog seam is avoided by matching colors,
 * not by fogging the sky).
 */
function makeDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(DOME_RADIUS, 32, 24);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uHorizonColor: { value: new THREE.Color(SKY_HORIZON_COLOR) },
      uZenithColor: { value: new THREE.Color(SKY_ZENITH_COLOR) },
      uGradientPower: { value: SKY_GRADIENT_POWER },
    },
    vertexShader: DOME_VERTEX,
    fragmentShader: DOME_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(geometry, material);
  dome.name = 'sky-dome';
  dome.renderOrder = -1; // draw before all opaque town geometry
  dome.frustumCulled = false; // it surrounds the camera; never cull it
  return dome;
}

/* -------------------------------------------------------------------------- */
/* Starfield                                                                   */
/* -------------------------------------------------------------------------- */

/** Vertex shader: fixed-distance points sized in pixels, with a subtle twinkle. */
const STAR_VERTEX = `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uTwinkleSpeed;
  uniform float uTwinkleAmount;
  attribute float aSize;
  attribute float aPhase;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vBright;
  void main() {
    vColor = aColor;
    // Twinkle: a gentle per-star brightness wobble around 1.0.
    float tw = 1.0 - uTwinkleAmount + uTwinkleAmount * sin(uTime * uTwinkleSpeed + aPhase * 6.2831853);
    vBright = tw;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // All stars share one distance, so no size attenuation is needed.
    gl_PointSize = aSize * uPixelRatio;
  }
`;

/** Fragment shader: a soft round dot, additively blended, fog-exempt. */
const STAR_FRAGMENT = `
  varying vec3 vColor;
  varying float vBright;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float a = smoothstep(0.5, 0.0, d);
    a *= a; // sharpen the core so points read as pinpricks, not blobs
    vec3 col = vColor * vBright;
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Build the deterministic starfield. Stars are scattered on a sphere just inside
 * the dome, biased toward the upper hemisphere; each gets a size (most small, a
 * few large), a slightly temperature-varied near-white color pre-scaled by a
 * random brightness, and a twinkle phase — all drawn from a fixed-seed PRNG so
 * the sky is identical every run. Additive, depth-write-off, fog-off, and its
 * `uTime` uniform is driven from `onBeforeRender` so twinkle is fully
 * self-contained.
 */
function makeStars(): THREE.Points {
  const rng = mulberry32(STAR_SEED);
  const radius = DOME_RADIUS * STAR_RADIUS_FRAC;

  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  const sizes = new Float32Array(STAR_COUNT);
  const phases = new Float32Array(STAR_COUNT);

  for (let i = 0; i < STAR_COUNT; i++) {
    // Uniform-area sampling over the upper cap: y uniform in [STAR_MIN_Y, 1].
    const y = STAR_MIN_Y + (1 - STAR_MIN_Y) * rng();
    const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = rng() * Math.PI * 2;
    const i3 = i * 3;
    positions[i3 + 0] = Math.cos(theta) * ringRadius * radius;
    positions[i3 + 1] = y * radius;
    positions[i3 + 2] = Math.sin(theta) * ringRadius * radius;

    // Brightness: most stars faint, dimmed toward STAR_BRIGHT_MIN.
    const bright = STAR_BRIGHT_MIN + (1 - STAR_BRIGHT_MIN) * rng();
    // Color temperature: a subtle cool/warm jitter around white.
    const warmth = rng();
    const r = bright * (0.86 + 0.14 * warmth);
    const g = bright * 0.94;
    const b = bright * (0.86 + 0.14 * (1 - warmth));
    colors[i3 + 0] = r;
    colors[i3 + 1] = g;
    colors[i3 + 2] = b;

    // Size: cubed bias -> lots of tiny stars, a handful of bright large ones.
    sizes[i] = STAR_MIN_PX + (STAR_MAX_PX - STAR_MIN_PX) * Math.pow(rng(), STAR_SIZE_BIAS);
    phases[i] = rng();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const pixelRatio = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uTwinkleSpeed: { value: TWINKLE_SPEED },
      uTwinkleAmount: { value: TWINKLE_AMOUNT },
    },
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });

  const stars = new THREE.Points(geometry, material);
  stars.name = 'sky-stars';
  stars.renderOrder = 1;
  stars.frustumCulled = false;
  // Self-contained twinkle: advance the time uniform every frame, no animate-loop wiring.
  stars.onBeforeRender = () => {
    material.uniforms.uTime.value = performance.now() / 1000;
  };
  return stars;
}

/* -------------------------------------------------------------------------- */
/* Moon                                                                        */
/* -------------------------------------------------------------------------- */

/** One radial-gradient color stop: `offset` in [0,1] and a CSS `rgba()` string. */
type Stop = readonly [number, string];

/**
 * Paint a radial gradient (center -> edge) into a square canvas and wrap it as an
 * sRGB {@link THREE.CanvasTexture}. Returns `null` when a 2D context is
 * unavailable (headless / offline), so the caller degrades gracefully by simply
 * not drawing that sprite — matching the {@link scene/TextureLibrary} pattern.
 */
function makeRadialTexture(size: number, stops: readonly Stop[]): THREE.CanvasTexture | null {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  for (const [offset, color] of stops) grad.addColorStop(offset, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build the moon: a bright-cored disc sprite plus a larger, fainter additive
 * halo behind it, both placed on the dome ALONG {@link MOON_LIGHT_POSITION} so
 * the visible source and the moon light's shadows agree. Sprites auto-billboard
 * toward the camera. Both opt out of fog and never write depth; the halo is
 * additive and deliberately faint so it reads as a soft glow through the fog
 * without washing out the stars behind it. Returns an empty-ish group if the
 * canvas textures can't be built (offline-safe).
 */
function makeMoon(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'sky-moon';

  // Place the moon on the dome along the moon light's direction vector.
  const dir = new THREE.Vector3(...MOON_LIGHT_POSITION).normalize();
  const pos = dir.multiplyScalar(DOME_RADIUS * MOON_POS_FRAC);

  // Broad, faint blue bloom drawn behind the disc.
  const haloTex = makeRadialTexture(MOON_TEX_SIZE, [
    [0.0, 'rgba(150,180,235,0.55)'],
    [0.22, 'rgba(140,175,230,0.26)'],
    [0.55, 'rgba(120,160,220,0.06)'],
    [1.0, 'rgba(120,160,220,0.0)'],
  ]);
  if (haloTex !== null) {
    const haloMat = new THREE.SpriteMaterial({
      map: haloTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.7,
      fog: false,
    });
    const halo = new THREE.Sprite(haloMat);
    halo.position.copy(pos);
    halo.scale.set(MOON_HALO_SIZE, MOON_HALO_SIZE, 1);
    halo.name = 'sky-moon-halo';
    halo.renderOrder = 2;
    halo.frustumCulled = false;
    group.add(halo);
  }

  // The disc itself: a solid pale-blue-white core with a soft rim.
  const discTex = makeRadialTexture(MOON_TEX_SIZE, [
    [0.0, 'rgba(255,255,255,1.0)'],
    [0.34, 'rgba(244,248,255,1.0)'],
    [0.5, 'rgba(214,228,255,0.85)'],
    [0.72, 'rgba(180,205,255,0.22)'],
    [1.0, 'rgba(180,205,255,0.0)'],
  ]);
  if (discTex !== null) {
    const discMat = new THREE.SpriteMaterial({
      map: discTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      opacity: 0.95,
      fog: false,
    });
    const disc = new THREE.Sprite(discMat);
    disc.position.copy(pos);
    disc.scale.set(MOON_DISC_SIZE, MOON_DISC_SIZE, 1);
    disc.name = 'sky-moon-disc';
    disc.renderOrder = 3;
    disc.frustumCulled = false;
    group.add(disc);
  }

  return group;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/** Handle returned by {@link createSky}. */
export interface Sky {
  /** Everything sky-related, parented under one group already added to the scene. */
  group: THREE.Group;
}

/**
 * Install the night sky: gradient skydome, deterministic twinkling starfield,
 * and a visible moon disc + halo aligned to the moon light. Everything is
 * bundled into a single {@link THREE.Group} added to `scene`. The fog is left
 * untouched (Atmosphere owns it); the sky simply opts out of fog and matches the
 * fog color at the horizon so there is no seam.
 *
 * Call once, immediately after `createAtmosphere(scene)` in `main.ts`.
 */
export function createSky(scene: THREE.Scene): Sky {
  const group = new THREE.Group();
  group.name = 'sky';
  group.add(makeDome());
  group.add(makeStars());
  group.add(makeMoon());
  scene.add(group);
  return { group };
}
