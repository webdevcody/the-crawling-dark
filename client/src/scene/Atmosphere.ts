/**
 * The Crawling Dark — atmosphere pass (M6 · t6e "the crawling dark").
 *
 * Centralizes the game's mood lighting so {@link main} stays lean and a later
 * M6 integration merge has a single, self-contained file to reason about. Three
 * concerns live here:
 *
 *   - {@link configureRenderer} — turn on soft shadow mapping (the ONLY renderer
 *     state this pass owns);
 *   - {@link createAtmosphere} — the dark cool ambient, the single cold moon
 *     key-light (the one and only shadow caster, with a perf-conscious shadow),
 *     and a close, tense fog that dissolves the distant town into black;
 *   - {@link addStreetLights} — a handful of warm sodium lamp posts placed
 *     deterministically along the main streets, each a visible glowing source
 *     but NONE of them shadow casters (so we keep exactly one shadow map).
 *
 * The single guiding constraint is performance: exactly ONE shadow-casting light
 * (the moon), a modest 2048² shadow map, and a shadow frustum pulled tight to
 * the play area. Everything else (fog density, ambient level, lamp count) is
 * tuned so the town reads as a tense, dark night that is never pitch black — the
 * player and the immediate streets stay legible while the far edges vanish.
 */

import * as THREE from 'three';
import { MAP_SIZE, type World } from '@crawling-dark/shared';

/* -------------------------------------------------------------------------- */
/* Palette + tunables                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The near-black the sky, fog and background all share, so distant geometry
 * fades seamlessly into the void with no visible fog "wall". Matches the value
 * `main.ts` previously set inline as `DARK` (0x05070a).
 */
const DARK = 0x05070a;

/** Cold blue-grey bounce fill. Kept dim so shadows stay deep, but never zero — pitch black is unplayable. */
const AMBIENT_COLOR = 0x2a3846;
const AMBIENT_INTENSITY = 0.45;

/** The moon: a pale, cold key-light raking across the town from high up. */
const MOON_COLOR = 0xa9c7ff;
const MOON_INTENSITY = 1.1;

/**
 * Fog band as fractions of {@link MAP_SIZE}. Denser than the old defaults
 * (0.12 → 0.9): fog now starts close (~13 m) and reaches full black by roughly
 * half the map (~70 m), so the immediate streets stay crisp while distant
 * buildings — and the perimeter wall out at ±64 — dissolve, hiding pop-in and
 * tightening the sense of a world that ends just past the streetlight.
 */
const FOG_NEAR_FRAC = 0.1;
const FOG_FAR_FRAC = 0.55;

/**
 * Shadow-camera half-extent in meters. The play area spans ±64 (the perimeter);
 * ±70 wraps it with a hair of margin while keeping the orthographic frustum as
 * tight as possible, which is what buys crisp shadows from a modest map.
 */
const SHADOW_HALF = 70;

/** Shadow map resolution (per side). 2048² is a deliberate perf/quality middle. */
const SHADOW_MAP_SIZE = 2048;

/* -------------------------------------------------------------------------- */
/* Street-light tunables                                                       */
/* -------------------------------------------------------------------------- */

/** Warm sodium-vapour tint shared by every lamp's bulb mesh and its point light. */
const LAMP_COLOR = 0xffb347;

/** Lamp-post height in meters (bulb sits at the top; the point light lives there too). */
const LAMP_HEIGHT = 4.2;

/**
 * Per-lamp point-light photometry. Three r0.171 uses physically-based units, so
 * with `decay = 2` intensity is candela and falls off inverse-square; a fairly
 * high raw `intensity` therefore only yields a small, local pool of warm light,
 * and `distance` hard-caps its reach so far lamps never bleed across the map.
 */
const LAMP_INTENSITY = 26;
const LAMP_DISTANCE = 22;
const LAMP_DECAY = 2;

/**
 * Deterministic lamp positions in world XZ, chosen to sit ON the town's street
 * grid so no bulb ever lands inside a building footprint. The town is a 6×6
 * block grid over [-54, 54] (cell size 18 m); the gaps between blocks — the
 * streets — run along x/z ∈ {0, ±18, ±36}, and the central plaza (radius 12 m)
 * is guaranteed building-free. These offsets place four lamps at the mouths of
 * the two main cross-streets where they meet the plaza, and four more at the
 * next ring of street intersections, giving symmetric coverage of the core.
 */
const LAMP_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  // Plaza mouths — cardinal, just outside the 12 m plaza on the main streets.
  [14, 0],
  [-14, 0],
  [0, 14],
  [0, -14],
  // Next ring — diagonal street intersections at x=±18, z=±18 (both clear lanes).
  [18, 18],
  [-18, 18],
  [18, -18],
  [-18, -18],
];

/* -------------------------------------------------------------------------- */
/* Renderer                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Enable shadow mapping on the renderer with percentage-closer soft filtering,
 * so the moon's single shadow map reads as soft contact shadows rather than hard
 * jagged edges. This is the only renderer state the atmosphere pass owns; the
 * caller keeps ownership of size / pixel-ratio / antialias. Call once, right
 * after the renderer is constructed.
 */
export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

/* -------------------------------------------------------------------------- */
/* Ambient + moon + fog                                                        */
/* -------------------------------------------------------------------------- */

/** Handles returned by {@link createAtmosphere}, in case a caller wants to tune them live. */
export interface Atmosphere {
  /** The cold, dim bounce fill (there is exactly one of these). */
  ambient: THREE.AmbientLight;
  /** The moon key-light — the single shadow caster in the whole scene. */
  moon: THREE.DirectionalLight;
}

/**
 * Install the core mood: a near-black background/fog, one dim cool ambient, and
 * one cold moon directional light that is the scene's SOLE shadow caster. The
 * moon's shadow is deliberately cheap — a modest {@link SHADOW_MAP_SIZE} map and
 * an orthographic frustum pulled tight to {@link SHADOW_HALF} around the play
 * area — with a small negative `bias` (plus `normalBias`) to keep the flat
 * building faces and ground free of shadow acne without visible peter-panning.
 *
 * This REPLACES the former inline ambient/moon/fog block in `main.ts`; the scene
 * ends up with exactly one ambient and one moon. Returns both light handles.
 */
export function createAtmosphere(scene: THREE.Scene): Atmosphere {
  const dark = new THREE.Color(DARK);

  // Background and fog share the same near-black so the far edge of the town
  // dissolves into the sky with no seam.
  scene.background = dark;
  // Linear fog: crisp up close, fully black by ~half the map — the "crawling dark".
  scene.fog = new THREE.Fog(dark, MAP_SIZE * FOG_NEAR_FRAC, MAP_SIZE * FOG_FAR_FRAC);

  // Dim cool fill so shadowed sides stay just barely legible (never pitch black).
  const ambient = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY);
  scene.add(ambient);

  // The moon: a cold key-light raking in from high on one side for long shadows.
  const moon = new THREE.DirectionalLight(MOON_COLOR, MOON_INTENSITY);
  moon.position.set(MAP_SIZE * 0.3, MAP_SIZE * 0.6, MAP_SIZE * 0.2);
  moon.target.position.set(0, 0, 0);

  // The one and only shadow caster in the scene.
  moon.castShadow = true;
  moon.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);

  // Pull the orthographic shadow frustum tight to the play area: the tighter the
  // frustum, the more shadow-map texels land on the town, so a modest map still
  // yields crisp shadows. near/far span the light's ~90 m throw to the ground
  // with margin to spare for the tallest (14 m) buildings.
  const shadowCam = moon.shadow.camera;
  shadowCam.left = -SHADOW_HALF;
  shadowCam.right = SHADOW_HALF;
  shadowCam.top = SHADOW_HALF;
  shadowCam.bottom = -SHADOW_HALF;
  shadowCam.near = 1;
  shadowCam.far = 200;
  shadowCam.updateProjectionMatrix();

  // Nudge samples off the surface to kill acne on the big flat faces/ground; the
  // small magnitudes avoid detaching shadows from their casters (peter-panning).
  moon.shadow.bias = -0.0005;
  moon.shadow.normalBias = 0.02;

  scene.add(moon);
  scene.add(moon.target);

  return { ambient, moon };
}

/* -------------------------------------------------------------------------- */
/* Street lights                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build a single lamp post at world (x, z): a thin dark cylinder topped by a
 * self-lit warm bulb, with a warm {@link THREE.PointLight} at the bulb. The bulb
 * is emissive so the SOURCE is visibly glowing even though the point light — for
 * performance — casts no shadow. The post grounds the light visually and does
 * cast the moon's shadow (it is cheap and thin); the glowing bulb does not, so
 * the light source never shadows itself. Returned as a group for the caller.
 */
function makeLamp(x: number, z: number): THREE.Group {
  const lamp = new THREE.Group();
  lamp.position.set(x, 0, z);

  // Post: a thin, dark, matte cylinder standing on the ground.
  const postGeo = new THREE.CylinderGeometry(0.09, 0.11, LAMP_HEIGHT, 6);
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x20262e,
    roughness: 0.85,
    metalness: 0.3,
  });
  const post = new THREE.Mesh(postGeo, postMat);
  post.position.y = LAMP_HEIGHT / 2; // centered geometry → lift so the base sits on y = 0
  post.castShadow = true;
  post.receiveShadow = false;
  lamp.add(post);

  // Bulb: a small emissive sphere at the top, the visible warm glow.
  const bulbGeo = new THREE.SphereGeometry(0.22, 12, 8);
  const bulbMat = new THREE.MeshStandardMaterial({
    color: LAMP_COLOR,
    emissive: LAMP_COLOR,
    emissiveIntensity: 2.2, // self-lit so it reads as the source, not a lit ball
    roughness: 0.4,
    metalness: 0,
  });
  const bulb = new THREE.Mesh(bulbGeo, bulbMat);
  bulb.position.y = LAMP_HEIGHT; // seated at the top of the post
  lamp.add(bulb);

  // The actual light: warm, modest reach, inverse-square falloff, NO shadow.
  const light = new THREE.PointLight(
    LAMP_COLOR,
    LAMP_INTENSITY,
    LAMP_DISTANCE,
    LAMP_DECAY,
  );
  light.position.y = LAMP_HEIGHT;
  light.castShadow = false; // exactly one shadow caster in the scene (the moon)
  lamp.add(light);

  return lamp;
}

/**
 * Scatter the {@link LAMP_OFFSETS} street lamps around the town and add them to
 * the scene as one 'streetlights' group. Positions are fixed and deterministic
 * (identical every run for a given town) and sit on the street grid, so no lamp
 * ever lands inside a building; `world.half` is used only as a safety clamp so a
 * future tweak to the offsets can never push a lamp past the perimeter wall.
 *
 * Call this once, right after the town is built, from `ensureWorld()` in
 * `main.ts` (the lamps reference the town's coordinate frame, so the world must
 * exist first).
 */
export function addStreetLights(scene: THREE.Scene, world: World): THREE.Group {
  const group = new THREE.Group();
  group.name = 'streetlights';

  // Keep every lamp a couple meters inside the perimeter wall, whatever offsets say.
  const limit = world.half - 2;

  for (const [x, z] of LAMP_OFFSETS) {
    if (Math.abs(x) > limit || Math.abs(z) > limit) continue;
    group.add(makeLamp(x, z));
  }

  scene.add(group);
  return group;
}
