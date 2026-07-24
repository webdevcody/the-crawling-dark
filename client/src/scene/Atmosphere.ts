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
import { MAP_SIZE, type Building, type World } from '@crawling-dark/shared';

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
// M11 (t11c): nudged 0.45 → 0.55. ACES filmic tone-mapping (main.ts) darkens the
// low end, so the shadowed, ambient-only sides of buildings crushed toward black;
// a small lift keeps them legibly dark-blue rather than pure void, without turning
// the night milky (the dark AMBIENT_COLOR still holds the shadows down).
const AMBIENT_INTENSITY = 0.55;

/** The moon: a pale, cold key-light raking across the town from high up. */
const MOON_COLOR = 0xa9c7ff;
// M11 (t11c): nudged 1.1 → 1.25. ACES rolls off the brightest values, so the
// former 1.1 key-light lost punch on moonlit faces; +0.15 restores the raking
// contrast while the filmic highlight roll-off keeps directly-lit faces from
// clipping to flat white.
const MOON_INTENSITY = 1.25;

/**
 * The moon's world position — and thus the direction its cold key-light rakes
 * in from. Exported as the SINGLE SOURCE OF TRUTH so the visible moon disc in
 * the sky (M11 · t11b) is placed along the exact same vector the light uses,
 * keeping the glowing source and the shadows it casts in agreement. Tune this
 * one vector and both the light and the disc follow.
 */
export const MOON_LIGHT_POSITION: readonly [number, number, number] = [
  MAP_SIZE * 0.3,
  MAP_SIZE * 0.6,
  MAP_SIZE * 0.2,
];

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
 * Road-walking placement (M11 t11d). Rather than a fixed offset list, lamps are
 * stepped DETERMINISTICALLY along the town's road polylines (World.roads) at
 * LAMP_SPACING-metre intervals, so the lighting follows wherever the M9 street
 * network actually runs. At the road grid's 18 m cell size this lands one lamp
 * at (essentially) every street intersection, giving even coverage of the core
 * and the outskirts alike without a single hand-placed coordinate.
 *
 * Two spacings govern the sweep:
 *   - LAMP_SPACING - the target gap between consecutive lamps ALONG a segment.
 *     Each segment is subdivided into evenly-spaced lamps that always include
 *     both endpoints, so every road intersection gets lit.
 *   - LAMP_MERGE_DIST - any candidate within this radius of an already-placed
 *     lamp is dropped, collapsing the duplicate lamps that otherwise pile up
 *     where two lanes (or a lane and the ring road) cross.
 */
const LAMP_SPACING = 18;
const LAMP_MERGE_DIST = 3;

/**
 * Keep the guaranteed-clear spawn plaza centre free of a physical post: players
 * spawn on a ~4 m ring around the origin, so the lone candidate that lands
 * exactly at (0, 0) (the central crossroads) is skipped. Every other lamp is at
 * least one 18 m cell out, so this only ever removes that single centre lamp.
 */
const LAMP_ORIGIN_CLEARANCE = 5;

/**
 * Live-PointLight budget for the WHOLE street-light system (road lamps plus the
 * pooled building lights below) - the guard that keeps the frame budget intact.
 * A road-walked town yields dozens of lamp POSTS, but posts + emissive bulbs are
 * cheap (shared geometry, no light) whereas real point lights are not. So only
 * the MAX_LAMP_LIGHTS sources nearest the core actually get a THREE.PointLight;
 * every lamp beyond the budget is a post + glowing bulb only, which still reads
 * as a light source at zero lighting cost. NONE of these lights cast shadows, so
 * the scene keeps its single shadow caster: the moon.
 */
const MAX_LAMP_LIGHTS = 18;

/**
 * Optional pooled warm light near the tallest buildings: a handful of cheap,
 * NON-shadow point lights that sit in the street on the plaza-facing side of the
 * biggest towers so their facades and the pavement below read as lit-from-within.
 * These are drawn from the SAME MAX_LAMP_LIGHTS budget (they are counted first),
 * so adding them never grows the total live-light count. The perimeter walls are
 * the shortest 'buildings', so a tallest-first pick never selects one.
 */
const MAX_BUILDING_LIGHTS = 4;
const BUILDING_LIGHT_COLOR = 0xffd9a0;
const BUILDING_LIGHT_INTENSITY = 42;
const BUILDING_LIGHT_DISTANCE = 34;
const BUILDING_LIGHT_HEIGHT = 9;
const BUILDING_LIGHT_DECAY = 2;

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
  moon.position.set(...MOON_LIGHT_POSITION);
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
  // M11 (t11c): the brighter moon above raises shadow contrast, so any acne on
  // grazing faces reads more; normalBias 0.02 → 0.03 offsets a little further along
  // the surface normal to suppress it — still well under one shadow texel (~68 mm
  // at a 140 m frustum / 2048² map), so the thin lamp-post shadows do not peter-pan.
  // `bias` is left at -0.0005: it was already clean, and depth-bias over a wide
  // ortho frustum is the axis more prone to peter-panning if pushed.
  moon.shadow.bias = -0.0005;
  moon.shadow.normalBias = 0.03;

  scene.add(moon);
  scene.add(moon.target);

  return { ambient, moon };
}

/* -------------------------------------------------------------------------- */
/* Street lights                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Shared lamp resources: one geometry + material for every post, and one for
 * every bulb. A road-walked town places dozens of lamps, so reusing these
 * (instead of allocating a fresh geometry/material per lamp, as the old
 * fixed-offset list did) keeps the memory + GC cost flat as the lamp count grows.
 */
interface LampResources {
  postGeo: THREE.CylinderGeometry;
  postMat: THREE.MeshStandardMaterial;
  bulbGeo: THREE.SphereGeometry;
  bulbMat: THREE.MeshStandardMaterial;
}

/**
 * Build a single lamp at world (x, z): a thin dark post topped by a self-lit warm
 * bulb, optionally with a warm THREE.PointLight at the bulb. The bulb is emissive
 * so the SOURCE is visibly glowing on EVERY lamp - including the budget-excluded
 * ones that carry no point light - so the whole street network reads as lit. The
 * post grounds the lamp visually and DOES cast the moon's shadow (thin and cheap);
 * the bulb and the point light do NOT, so the light source never shadows itself
 * and the moon stays the scene's one and only shadow caster.
 *
 * @param withLight when true, attach a (non-shadow) point light at the bulb; when
 *   false the lamp is post + glowing bulb only, at zero lighting cost.
 */
function makeLamp(
  x: number,
  z: number,
  withLight: boolean,
  res: LampResources,
): THREE.Group {
  const lamp = new THREE.Group();
  lamp.position.set(x, 0, z);

  // Post: a thin, dark, matte cylinder standing on the ground. Centered geometry
  // is lifted so the base sits on y = 0. Casts the moon's shadow (cheap and thin).
  const post = new THREE.Mesh(res.postGeo, res.postMat);
  post.position.y = LAMP_HEIGHT / 2;
  post.castShadow = true;
  post.receiveShadow = false;
  lamp.add(post);

  // Bulb: a small emissive sphere at the top, the visible warm glow. Present on
  // every lamp so even a light-less post still reads as a source, not a dark pole.
  const bulb = new THREE.Mesh(res.bulbGeo, res.bulbMat);
  bulb.position.y = LAMP_HEIGHT;
  lamp.add(bulb);

  // The actual light is budget-gated: warm, modest reach, inverse-square falloff,
  // and - like every lamp light - NO shadow (exactly one shadow caster: the moon).
  if (withLight) {
    const light = new THREE.PointLight(
      LAMP_COLOR,
      LAMP_INTENSITY,
      LAMP_DISTANCE,
      LAMP_DECAY,
    );
    light.position.y = LAMP_HEIGHT;
    light.castShadow = false;
    lamp.add(light);
  }

  return lamp;
}

/**
 * Walk every road polyline and return the deterministic set of lamp XZ positions.
 * Each segment is subdivided into evenly-spaced lamps (target gap LAMP_SPACING,
 * always including both endpoints so intersections are lit); every candidate is
 * clamped a couple of metres inside the perimeter wall, has the spawn-plaza
 * centre skipped, and is deduped against already-placed lamps within
 * LAMP_MERGE_DIST so the pile-ups at road crossings collapse to a single lamp.
 *
 * Ordering is fixed (roads array order, then along-segment order), so the result
 * - and therefore which lamps fall inside the light budget - is identical every
 * run for a given world; nothing here touches Math.random.
 */
function collectLampPositions(world: World): Array<{ x: number; z: number }> {
  const limit = world.half - 2;
  const positions: Array<{ x: number; z: number }> = [];

  const tryAdd = (rawX: number, rawZ: number): void => {
    // Clamp inside the perimeter wall. Roads never reach it, so this is purely a
    // guard against a future road tweak pushing a lamp through the wall.
    const x = Math.max(-limit, Math.min(limit, rawX));
    const z = Math.max(-limit, Math.min(limit, rawZ));
    // Keep the spawn-plaza centre clear of a physical post.
    if (Math.hypot(x, z) < LAMP_ORIGIN_CLEARANCE) return;
    // Drop duplicates piled up where roads cross.
    for (const p of positions) {
      if (Math.hypot(p.x - x, p.z - z) < LAMP_MERGE_DIST) return;
    }
    positions.push({ x, z });
  };

  for (const road of world.roads) {
    const pts = road.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      // Even subdivision including both ends: round the target spacing to fit the
      // segment exactly, so the along-street gap stays close to LAMP_SPACING.
      const steps = Math.max(1, Math.round(len / LAMP_SPACING));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        tryAdd(a.x + dx * t, a.z + dz * t);
      }
    }
  }

  return positions;
}

/**
 * A cheap pooled warm light for one tall building: a NON-shadow point light set
 * in the street just outside the tower's footprint on the plaza-facing (toward
 * origin) side, so it lights the facade and pavement instead of being trapped
 * inside the box. Like every street light it casts no shadow (the moon is the
 * sole shadow caster).
 */
function makeBuildingLight(b: Building): THREE.PointLight {
  const light = new THREE.PointLight(
    BUILDING_LIGHT_COLOR,
    BUILDING_LIGHT_INTENSITY,
    BUILDING_LIGHT_DISTANCE,
    BUILDING_LIGHT_DECAY,
  );
  // Push out of the footprint toward the origin (guard the degenerate centre).
  const d = Math.hypot(b.cx, b.cz);
  const ux = d > 1e-6 ? b.cx / d : 0;
  const uz = d > 1e-6 ? b.cz / d : 0;
  const out = Math.max(b.hw, b.hd) + 2;
  light.position.set(b.cx - ux * out, BUILDING_LIGHT_HEIGHT, b.cz - uz * out);
  light.castShadow = false; // exactly one shadow caster in the scene (the moon)
  return light;
}

/**
 * Light the town along its M9 road network. Lamps are stepped deterministically
 * along World.roads (see collectLampPositions) and added to the scene as one
 * 'streetlights' group; a strict MAX_LAMP_LIGHTS budget of live point lights is
 * spent core-first (nearest the origin), plus up to MAX_BUILDING_LIGHTS pooled
 * warm lights at the tallest towers - every one of them a NON-shadow light, so
 * the moon remains the scene's single shadow caster. Lamps beyond the budget are
 * posts + emissive bulbs only, so the streets read as fully lit at a fixed,
 * capped lighting cost.
 *
 * Call this once, right after the town is built, from ensureWorld() in main.ts
 * (the lamps reference the town's coordinate frame, so the world must exist).
 */
export function addStreetLights(scene: THREE.Scene, world: World): THREE.Group {
  const group = new THREE.Group();
  group.name = 'streetlights';

  // Shared geometry/material for every post and every bulb (see LampResources).
  const res: LampResources = {
    postGeo: new THREE.CylinderGeometry(0.09, 0.11, LAMP_HEIGHT, 6),
    postMat: new THREE.MeshStandardMaterial({
      color: 0x20262e,
      roughness: 0.85,
      metalness: 0.3,
    }),
    bulbGeo: new THREE.SphereGeometry(0.22, 12, 8),
    bulbMat: new THREE.MeshStandardMaterial({
      color: LAMP_COLOR,
      emissive: LAMP_COLOR,
      emissiveIntensity: 2.2,
      roughness: 0.4,
      metalness: 0,
    }),
  };

  // Pooled building lights claim the FRONT of the light budget: pick the tallest
  // towers (walls are the shortest buildings, so they never make the cut).
  let lightBudget = MAX_LAMP_LIGHTS;
  const towers = world.buildings
    .slice()
    .sort((p, q) => q.height - p.height)
    .slice(0, Math.min(MAX_BUILDING_LIGHTS, MAX_LAMP_LIGHTS));
  for (const b of towers) {
    group.add(makeBuildingLight(b));
    lightBudget--;
  }

  // Road-walked lamps, nearest-the-core first: the first `lightBudget` get a real
  // point light; the rest are post + glowing bulb only.
  const positions = collectLampPositions(world);
  positions.sort((p, q) => Math.hypot(p.x, p.z) - Math.hypot(q.x, q.z));
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    group.add(makeLamp(p.x, p.z, i < lightBudget, res));
  }

  scene.add(group);
  return group;
}
