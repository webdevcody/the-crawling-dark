/**
 * The Crawling Dark — client entry point (M6 · Prediction & Polish).
 *
 * Wires the M2 systems into a playable third-person scene:
 *   - the seeded town ({@link buildTown}) rendered from the same {@link World}
 *     the server collides against, rebuilt on the client from WELCOME's `mapSeed`;
 *   - keyboard + pointer-lock mouse look ({@link Controls}) packed into INPUT
 *     frames (held-key bitmask + look yaw) streamed every frame;
 *   - a third-person spring-arm follow camera ({@link FollowCamera}) that trails
 *     the local player and retracts around walls;
 *   - remote entities rendered from interpolated snapshots (~INTERP_BUFFER_MS in
 *     the past) so everyone moves smoothly; the LOCAL player is client-predicted.
 *
 * M3 (t3d) layers combat on top: left-click sends an ATTACK; bodies are colored
 * by team (human vs zombie) and repaint the instant an infection flips a body's
 * `kind`; entity `state` drives the swing / stun / downed tells; and the
 * server's attack/stun/infect events (drained from {@link Connection.drainEvents})
 * spawn short-lived VFX and feed a bottom-left kill/turn ticker.
 *
 * M5 (t5d) surfaces the round loop so a full match reads on screen: the inline
 * status readout is replaced by the {@link HUD} module, driven each frame from
 * the server's ROUND messages (lobby -> countdown -> the 5:00 round -> a
 * win/lose banner -> back to lobby). `R` toggles the local lobby ready state
 * (streamed via {@link Connection.sendReady}); the flag resets whenever the
 * round returns to `lobby`, matching the server clearing readiness on reset.
 *
 * M6 makes it feel good: the local player is now client-predicted + reconciled
 * ({@link Predictor}, t6a) so it responds instantly; entities are drawn as rigged,
 * animated {@link Character} rigs (t6c); the HUD shows a server-authoritative
 * stamina bar (t6b); a procedural {@link AudioEngine} adds footsteps, combat SFX,
 * and a dark-town ambient bed (t6d); and the mood pass — one shadow-casting moon,
 * close fog, and warm street lamps ({@link createAtmosphere}, t6e) — sells the
 * crawling dark.
 */

import * as THREE from 'three';
import {
  MAP_SIZE,
  TICK_MS,
  CLIENT_FPS,
  ROUND_LENGTH_MS,
  generateWorld,
  type World,
  type EntityKind,
  type RoundMessage,
} from '@crawling-dark/shared';
import { Connection } from './net/Connection';
import { Predictor } from './predict/Predictor';
import { Controls } from './input/Controls';
import { FollowCamera } from './scene/FollowCamera';
import { buildTown } from './scene/TownView';
import { buildEnvironment, disposeEnvironment } from './scene/Environment';
import { Water } from './scene/Water';
import { TextureLibrary, makeStandardMaterial, makeGroundDirtSet } from './scene/TextureLibrary';
import { Character, type CharacterModel } from './entities/Character';
import { GltfCharacter } from './entities/GltfCharacter';
import {
  configureRenderer,
  createAtmosphere,
  addStreetLights,
} from './scene/Atmosphere';
import { createSky } from './scene/Sky';
import { HUD } from './ui/HUD';
import { AudioEngine, type Point3, type FootstepSurface } from './audio/AudioEngine';
import { AudioControls } from './ui/AudioControls';
import type { InterpolatedEntity } from './net/Interpolation';
import { PostFx } from './scene/PostFx';
import { Particles } from './scene/Particles';
import { CameraShake } from './scene/CameraShake';
import { ScreenFx } from './ui/ScreenFx';
// M15 — HUD & UX polish (radar minimap, scoreboard, settings menu, reticle).
import { Minimap } from './ui/Minimap';
import { Scoreboard } from './ui/Scoreboard';
import { Settings, type RenderQuality, type SettingsState } from './ui/Settings';
import { SettingsMenu } from './ui/SettingsMenu';
import { Reticle } from './ui/Reticle';
// M16 — Menus & Onboarding (title screen, controls/help overlay, Esc pause menu,
// and the kill/turn feed extracted into its own module).
import { TitleScreen } from './ui/TitleScreen';
import { HelpOverlay } from './ui/HelpOverlay';
import { PauseMenu } from './ui/PauseMenu';
import { KillFeed } from './ui/KillFeed';
// M17 — Round Presentation & Accessibility (results screen, turn/death overlay,
// round-start role reveal, and a reduced-motion accessibility gate).
import { RoundEndScreen } from './ui/RoundEndScreen';
import { TurnOverlay } from './ui/TurnOverlay';
import { RoundIntro } from './ui/RoundIntro';
import { prefersReducedMotion } from './ui/a11y';

const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;

/* -------------------------------------------------------------------------- */
/* Renderer                                                                   */
/* -------------------------------------------------------------------------- */

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// M11 (t11c): color-management + tone-mapping pass. Render the scene through the
// ACES filmic curve so bright emissive sources (lamp bulbs, lit windows, the moon
// disc) roll off gracefully toward white instead of hard-clipping, while mid-tones
// keep their contrast. ACES darkens the image slightly versus a raw linear clamp,
// so a modest >1 exposure keeps the night legible (never pitch black) without
// pushing those highlights back into clipping; the ambient/moon intensities in
// Atmosphere.ts are re-balanced against this same curve.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
// M11 (t11c): set explicitly (the r152+ default) so the final image is sRGB-encoded
// and our authored sRGB colors/textures read correctly end-to-end.
renderer.outputColorSpace = THREE.SRGBColorSpace;
// M6 (t6e): enable the moon's soft shadow map (see Atmosphere.ts).
configureRenderer(renderer);
// M14: the post-processing composer renders the scene + several full-screen
// passes per frame, each of which would auto-reset renderer.info — leaving the
// perf overlay (t8e) reading only the LAST pass. Take ownership of the reset
// (once per frame, just before the draw) so draws/tris report the true total.
renderer.info.autoReset = false;
// M10 (t10a): capture the GPU's max anisotropy so every tiled PBR texture the
// TextureLibrary hands out stays crisp at grazing angles. Must run before any
// world/material is built (the town is built later, on WELCOME).
TextureLibrary.init(renderer);
app.appendChild(renderer.domElement);

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

const scene = new THREE.Scene();
// M6 (t6e): the whole mood pass — near-black background + close tense fog, one
// dim cool ambient, and the single shadow-casting moon — lives in Atmosphere.ts.
// This replaces the former inline background/fog and the ambient/moon block below.
createAtmosphere(scene);
// M11 (t11a/t11b): the night sky — a gradient skydome, a deterministic
// twinkling starfield, and a moon disc + halo aligned to the moon light —
// lives in Sky.ts. It opts out of fog and matches the fog color at the
// horizon, so scene.fog (owned by Atmosphere) is untouched and seam-free.
createSky(scene);

/* -------------------------------------------------------------------------- */
/* Camera — third-person spring-arm follow (starts at a gentle overview)      */
/* -------------------------------------------------------------------------- */

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
// Until the local player exists, sit at a readable overview of the plaza.
camera.position.set(0, 14, 20);
camera.lookAt(0, 1, 0);

const follow = new FollowCamera(camera);

/* -------------------------------------------------------------------------- */
/* M14 — VFX & post-processing (bloom + horror grade, particles, camera juice, */
/* screen-space feedback). Pure client-side game-feel over the M8-M13 base.    */
/* -------------------------------------------------------------------------- */

// Post-processing: RenderPass -> bloom -> horror vignette/grain -> OutputPass.
// The composer performs the final ACES + sRGB (M11), so the renderer's
// tone-mapping stays untouched. `P` toggles it (postFx.enabled) for an A/B.
const postFx = new PostFx(renderer, scene, camera);

// Trauma-based camera shake + FOV kick + landing punch, applied as a
// non-accumulating offset AFTER follow.update each frame (which fully rewrites
// the camera transform, so the offset never drifts).
const cameraShake = new CameraShake(camera);

// Pooled GPU particle system (one Points draw): bat-impact sparks, infection
// spores, footstep/landing dust - driven off the server event stream below.
const particles = new Particles(scene);

// Local-player screen-space feedback: an infection flash on turning, plus a
// proximity 'danger' vignette that rises as the nearest zombie closes in.
const screenFx = new ScreenFx(app);

/* -------------------------------------------------------------------------- */
/* Ground plane + grid                                                        */
/* -------------------------------------------------------------------------- */

const groundGeometry = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE);
groundGeometry.rotateX(-Math.PI / 2);
// M10 (t10a demo / t10b): the ground is the pipeline's first real surface — a
// tiled procedural dirt PBR material (albedo + bump-normal + roughness) instead
// of the former flat 0x141c26 plane. One tile spans GROUND_TILE_METERS, so the
// map repeats MAP_SIZE / GROUND_TILE_METERS times across the plane; the maps are
// seamless so there is no visible repeat/seam at play distance. If texture
// generation is unavailable (offline/headless), makeStandardMaterial falls back
// to the old flat color automatically.
const GROUND_TILE_METERS = 8;
const groundRepeat = MAP_SIZE / GROUND_TILE_METERS;
const groundMaterial = makeStandardMaterial(
  TextureLibrary.get('ground-dirt', () => makeGroundDirtSet(256)),
  { repeat: groundRepeat, color: 0x141c26, roughness: 1, metalness: 0, normalScale: 0.8 },
);
const ground = new THREE.Mesh(groundGeometry, groundMaterial);
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(MAP_SIZE, MAP_SIZE / 4, 0x243244, 0x121a22);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.28;
grid.position.y = 0.01;
scene.add(grid);

/* -------------------------------------------------------------------------- */
/* Networking + input                                                         */
/* -------------------------------------------------------------------------- */

const connection = new Connection();
const controls = new Controls();
controls.attachPointerLock(renderer.domElement);
connection.connect();

/* -------------------------------------------------------------------------- */
/* M15 — HUD & UX polish (minimap, scoreboard, settings menu, reticle)          */
/* -------------------------------------------------------------------------- */

/**
 * Persisted client preferences (localStorage-backed, offline-safe). The single
 * source of truth for the {@link settingsMenu}; each value is pushed into the
 * real systems by {@link applySetting} once at startup and again on every change.
 */
const settings = new Settings();

/** Render-quality tier → device-pixel-ratio cap (crisper but costlier up the scale). */
const QUALITY_DPR_CAP: Readonly<Record<RenderQuality, number>> = {
  low: 1,
  medium: 1.5,
  high: 2,
};

/** Corner radar minimap (top-right); visibility follows the `minimap` preference. */
const minimap = new Minimap(app);

/** Held-`Tab` scoreboard / player roster overlay. */
const scoreboard = new Scoreboard(app);

/** Center combat crosshair (swing-cooldown) + bottom objective banner. */
const reticle = new Reticle(app);

/** Options modal bound to {@link settings}; toggled with `O`. */
const settingsMenu = new SettingsMenu(app, settings);

/**
 * Apply one preference to the live systems. Invoked for every key at startup and
 * again from the {@link settings} subscription whenever a value actually changes,
 * so the menu (and the `N` minimap shortcut) drive the real renderer/controls.
 */
function applySetting(key: keyof SettingsState): void {
  switch (key) {
    case 'postProcessing':
      postFx.enabled = settings.get('postProcessing');
      break;
    case 'minimap':
      minimap.setVisible(settings.get('minimap'));
      break;
    case 'mouseSensitivity':
      controls.setSensitivity(settings.get('mouseSensitivity'));
      break;
    case 'renderQuality': {
      const cap = QUALITY_DPR_CAP[settings.get('renderQuality')];
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
      // Keep the post-processing composer's internal targets in lock-step with
      // the renderer's new pixel ratio.
      postFx.setSize(window.innerWidth, window.innerHeight);
      break;
    }
    default:
      break;
  }
}

// Push every stored preference into the live systems once, then keep them synced.
(Object.keys(settings.getAll()) as (keyof SettingsState)[]).forEach(applySetting);
const unsubscribeSettings = settings.subscribe((key) => applySetting(key));

/* -------------------------------------------------------------------------- */
/* Audio — procedural Web Audio (no assets); resumed on the first gesture       */
/* -------------------------------------------------------------------------- */

/**
 * The whole game's sound, synthesized with the Web Audio API (no bundled audio
 * assets exist in this sandbox). The context can only start after a user
 * gesture, so {@link AudioEngine.resume} + {@link AudioEngine.startAmbient} are
 * called from the existing first-gesture hooks below (canvas mousedown, the `R`
 * keydown, and the audio panel itself). It is fed the listener position each
 * frame and triggered from gameplay events + the footstep driver in {@link animate}.
 */
const audio = new AudioEngine();

/**
 * Register the t12b one-shot sample names (optional, offline-safe). No binary
 * files ship for these, so every fetch 404s and the {@link AudioEngine} synth
 * voice plays instead — this merely lets real recordings be dropped into
 * `client/public/audio/sfx/` later with zero code changes (the loader swallows
 * misses; see {@link AudioEngine.loadSamples}).
 */
audio.loadSamples({
  jump: 'audio/sfx/jump.wav',
  land: 'audio/sfx/land.wav',
  zombie_groan: 'audio/sfx/zombie_groan.wav',
  zombie_snarl: 'audio/sfx/zombie_snarl.wav',
  zombie_claw: 'audio/sfx/zombie_claw.wav',
  round_start: 'audio/sfx/round_start.wav',
  round_end_human: 'audio/sfx/round_end_human.wav',
  round_end_zombie: 'audio/sfx/round_end_zombie.wav',
  lobby_ready: 'audio/sfx/lobby_ready.wav',
  footstep_dirt: 'audio/sfx/footstep_dirt.wav',
  footstep_wet: 'audio/sfx/footstep_wet.wav',
});

/** Bottom-right mute/volume panel; also binds `M` to toggle mute. */
const audioControls = new AudioControls(app, audio);

/* -------------------------------------------------------------------------- */
/* M16 — Menus & Onboarding (title, controls/help, Esc pause, kill feed)        */
/* -------------------------------------------------------------------------- */

/**
 * Bottom-left kill / turn feed (M16 · t16d) — the same self-expiring stack that
 * used to be inlined here, now its own module. Fed pre-formatted strings from the
 * event loop ({@link Connection.drainEvents}) and aged out each frame.
 */
const killFeed = new KillFeed(app);

/** Toggleable controls reference (M16 · t16b), opened with `H` / `?` or from the pause menu. */
const helpOverlay = new HelpOverlay(app);

/**
 * Esc pause menu (M16 · t16c). The browser drops pointer lock on `Esc`; the
 * {@link pointerlockchange} hook below turns that mid-play exit into an open
 * pause panel. Its buttons route back into the live systems: Resume re-requests
 * pointer lock, Controls opens the help overlay, and Settings opens the options
 * modal — closing the pause panel first so it isn't hidden behind it (the pause
 * panel rides a higher zIndex than the settings modal).
 */
const pauseMenu = new PauseMenu(app, {
  onResume: () => renderer.domElement.requestPointerLock(),
  onControls: () => helpOverlay.open(),
  onSettings: () => {
    pauseMenu.close();
    settingsMenu.open();
  },
});

/**
 * Title / start screen (M16 · t16a), shown on first load and gating entry. Play
 * counts as the first user gesture, so it unlocks audio and requests pointer lock
 * to drop straight into mouse-look. Constructed LAST so it mounts on top.
 */
const titleScreen = new TitleScreen(app, () => {
  audio.resume();
  audio.startAmbient();
  audio.startMusic();
  renderer.domElement.requestPointerLock();
});

/**
 * Turn a pointer-lock EXIT into a pause. The browser drops pointer lock on `Esc`
 * (and on tab-blur); when that happens mid-play — the title is dismissed and no
 * pause panel is already up — open the pause menu. Re-acquiring the lock (Play or
 * Resume) closes it. Guarded so it never fires under the title screen or a menu.
 */
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (locked) pauseMenu.close();
  else if (!titleScreen.visible && !pauseMenu.visible) pauseMenu.open();
});

/* -------------------------------------------------------------------------- */
/* M17 — Round Presentation & Accessibility                                     */
/* -------------------------------------------------------------------------- */

/**
 * The end-of-round results card (M17 · t17a) — a larger victory/defeat summary
 * (outcome, your personal result, final tally, return countdown) shown only
 * while `phase === 'ended'`. Non-interactive; layered beneath the menus.
 */
const roundEndScreen = new RoundEndScreen(app);

/** A brief "YOU HAVE BEEN TURNED" splash (M17 · t17b), fired on local infection. */
const turnOverlay = new TurnOverlay(app);

/** A one-time role-reveal intro (M17 · t17c) shown the frame a round goes active. */
const roundIntro = new RoundIntro(app);

/**
 * Push the effective reduced-motion preference — the stored toggle OR the OS
 * `prefers-reduced-motion` signal (via {@link prefersReducedMotion}) — into every
 * animated overlay, so a motion-sensitive player's fades/slides are suppressed.
 * Applied once at startup and again whenever the preference changes.
 */
function applyReducedMotion(): void {
  const reduced = prefersReducedMotion(settings);
  roundEndScreen.setReducedMotion(reduced);
  turnOverlay.setReducedMotion(reduced);
  roundIntro.setReducedMotion(reduced);
  killFeed.setReducedMotion(reduced);
}
applyReducedMotion();
const unsubscribeReducedMotion = settings.subscribe((key) => {
  if (key === 'reducedMotion') applyReducedMotion();
});

/**
 * Client-side prediction for the LOCAL player (M6 · t6a). Fed this frame's input
 * immediately so our own body reacts without a round-trip, then corrected against
 * each authoritative snapshot. Remote entities are untouched — they keep flowing
 * through the interpolator (see {@link Predictor}).
 */
const predictor = new Predictor();

/**
 * Server tick of the last snapshot we reconciled against, so we reconcile exactly
 * once per new snapshot (the tick strictly increases between snapshots). `null`
 * until the first reconcile lands.
 */
let lastReconciledTick: number | null = null;

/**
 * Left-click to swing the bat. Pointer lock is requested by Controls on the
 * FIRST canvas click, and at that mousedown the pointer is not yet locked — so
 * that click only enters play and never swings. Every subsequent left-click
 * fires only while `pointerLocked` (i.e. actually playing), cleanly separating
 * click-to-play from click-to-swing without fighting the lock wiring. Right and
 * middle buttons are ignored.
 */
renderer.domElement.addEventListener('mousedown', (ev) => {
  // First-gesture audio unlock: this fires on the very first canvas click (the
  // click-to-lock one), before the pointer-lock guard below returns, so the
  // AudioContext resumes and the ambient bed starts the moment play begins.
  audio.resume();
  audio.startAmbient();
  audio.startMusic();
  if (ev.button !== 0) return;
  if (!controls.pointerLocked) return;
  connection.sendAttack();
  // M15: start the reticle's swing-cooldown recharge animation on our own swing.
  reticle.onSwing();
});

/* -------------------------------------------------------------------------- */
/* Lobby ready toggle (R)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Our local lobby ready state, the source of truth for the `R` toggle. It is
 * mirrored to the server via {@link Connection.sendReady} on each press and read
 * by the HUD to show your ready status. The server clears everyone's readiness
 * on a round reset, so we reset this to `false` on every transition back to the
 * `lobby` phase (detected off ROUND below) to stay in lock-step.
 */
let localReady = false;

/**
 * `R` toggles ready. Bound on `window` (not the canvas) so it works in the
 * lobby, which is played WITHOUT pointer lock — a click-to-lock gate would make
 * readying up impossible. Auto-repeat is ignored so a held key can't rapidly
 * flip the state, mirroring how {@link Controls} debounces the crawl toggle.
 */
window.addEventListener('keydown', (ev) => {
  if (ev.code !== 'KeyR' || ev.repeat) return;
  // Readying up in the lobby is a user gesture too — unlock audio here as well
  // so a keyboard-only player who never clicks the canvas still gets sound.
  audio.resume();
  audio.startAmbient();
  audio.startMusic();
  localReady = !localReady;
  connection.sendReady(localReady);
  // A friendly confirm blip when you ready up (t12b). Emitted at the origin so
  // it reads centred: in the lobby the listener sits on the spawn plaza, and
  // when there is no local body yet the listener defaults to the origin too.
  if (localReady) audio.lobbyReady({ x: 0, y: 0, z: 0 });
});

/** Last round phase we observed, to detect the transition back into `lobby`. */
let lastPhase: string | null = null;

/* -------------------------------------------------------------------------- */
/* Town — built once WELCOME's mapSeed arrives (identical to the server's)     */
/* -------------------------------------------------------------------------- */

/** The seeded town, once we know the seed; drives building meshes + camera collision. */
let world: World | null = null;

/**
 * The M9 environment (forest / roads / scatter props) and lake surface, built
 * alongside the town so they can be disposed together on teardown. `null` until
 * the world exists; `water` stays `null` for a seed with no lake.
 */
let environment: THREE.Group | null = null;
let water: Water | null = null;

/** Build the town exactly once, as soon as the deterministic seed is known. */
function ensureWorld(): void {
  if (world !== null) return;
  const seed = connection.mapSeed;
  if (seed === null) return;
  world = generateWorld(seed);
  scene.add(buildTown(world));
  // M6 (t6e): warm sodium lamp posts along the streets, now that the town exists.
  addStreetLights(scene, world);
  // M9 (t9e): the instanced forest, road ribbons, and scatter props.
  environment = buildEnvironment(world);
  scene.add(environment);
  // M9 (t9d): the animated lake surface, when this seed has water.
  if (world.water !== null) {
    water = new Water(world.water);
    scene.add(water.mesh);
  }
}

/* -------------------------------------------------------------------------- */
/* Entity characters — reconciled against interpolated snapshots each frame     */
/* -------------------------------------------------------------------------- */

/**
 * THE single M13 renderer switch: how entity bodies are drawn.
 * `'gltf'` (the M13 default) renders the rigged models from
 * `client/public/models/` via {@link GltfCharacter} — the improved human
 * (t13b) and distinct hunched zombie (t13c) baked by `scripts/gen-*-glb.mjs`.
 * It falls back to the procedural rig PER BODY whenever an asset is missing, so
 * it stays offline-safe. `'procedural'` keeps the built-in articulated rig
 * ({@link Character}) with zero asset dependency; because the heavy GLTFLoader
 * is imported dynamically inside {@link GltfCharacter}, setting this back to
 * `'procedural'` also keeps the loader out of the main bundle. Both values
 * honor the {@link CharacterModel} seam, so NOTHING else in this file changes.
 */
const CHARACTER_RENDERER: 'procedural' | 'gltf' = 'gltf';

/**
 * Model URLs used when {@link CHARACTER_RENDERER} is `'gltf'`. The distinct
 * `zombie` URL makes an infection MODEL-SWAP (t13c) — a human's upright,
 * bat-carrying body (t13b) becomes the hunched zombie — on top of the
 * per-instance team recolor. Each `.glb` is baked CC0 by our own generator
 * scripts (see `client/public/models/ATTRIBUTION.md`), so no network fetch.
 */
const GLTF_MODELS = {
  human: '/models/human.glb',
  zombie: '/models/zombie.glb',
} as const;

/** Build one body behind the {@link CharacterModel} seam per the switch above. */
function createCharacter(id: number): CharacterModel {
  return CHARACTER_RENDERER === 'gltf'
    ? new GltfCharacter(id, GLTF_MODELS)
    : new Character(id);
}

/**
 * Live character rigs keyed by entity id, mirroring the interpolated entity set.
 * Each {@link Character} is an articulated humanoid built behind the
 * {@link CharacterModel} seam (see `entities/Character.ts`), so the box-per-body
 * renderer this replaced — and, later, a GLTF/AnimationMixer body — can be
 * swapped in without touching the reconciliation loop below.
 */
const characters = new Map<number, CharacterModel>();

/**
 * `performance.now()` of the previous {@link syncEntities} call, used to derive a
 * per-frame delta for the rigs (the procedural animation is time-based off
 * `nowMs` and ignores it, but the seam passes it through for a future
 * `AnimationMixer.update`). Kept here so {@link syncEntities} can preserve its
 * exact `(entities, nowMs)` signature — no dt parameter is added to it.
 */
let lastCharNowMs = 0;

/**
 * Reconcile character rigs with the interpolated entity set: spawn new bodies,
 * recolor any whose team (`kind`) flipped this frame, drive their movement/combat
 * pose via {@link Character.update}, and dispose rigs for entities that have left.
 * Returns the local player's feet position for the follow camera, or `null` if
 * the local entity isn't present. `nowMs` (a {@link performance.now} reading)
 * drives the time-based animation.
 */
function syncEntities(
  entities: Map<number, InterpolatedEntity>,
  nowMs: number,
): { x: number; y: number; z: number } | null {
  const localId = connection.playerId;
  // Reuse a module scratch for the returned feet position (M8 · t8e) rather than
  // allocating a fresh `{x,y,z}` every frame; the caller consumes it immediately.
  let haveLocal = false;

  // Frame delta for the rigs, clamped so a stalled tab can't fling the pose.
  const dtMs = lastCharNowMs === 0 ? 0 : Math.min(100, Math.max(0, nowMs - lastCharNowMs));
  lastCharNowMs = nowMs;

  for (const entity of entities.values()) {
    const isLocal = entity.id === localId;

    let character = characters.get(entity.id);
    if (character === undefined) {
      character = createCharacter(entity.id);
      character.setTeam(entity.kind, isLocal);
      scene.add(character.root);
      characters.set(entity.id, character);
    } else if (character.kind !== entity.kind) {
      // A human turning into a zombie keeps its id but changes `kind`; recolor
      // (and reshape) the body the instant that flip is observed so the
      // infection is visible.
      character.setTeam(entity.kind, isLocal);
    }

    // `root` origin is at the feet, so the entity's `{x, y, z}` (feet height,
    // >0 mid-jump) places the body directly; facing + pose are applied inside.
    character.root.position.set(entity.x, entity.y, entity.z);
    character.update(entity.state, entity.yaw, nowMs, dtMs);

    if (isLocal) {
      localFeetScratch.x = entity.x;
      localFeetScratch.y = entity.y;
      localFeetScratch.z = entity.z;
      haveLocal = true;
    }
  }

  // Remove departed entities, disposing each rig's owned material. The shared
  // limb geometries live in `Character.ts` and are never disposed here.
  for (const [id, character] of characters) {
    if (!entities.has(id)) {
      scene.remove(character.root);
      character.dispose();
      characters.delete(id);
    }
  }

  return haveLocal ? localFeetScratch : null;
}

/**
 * Reused feet-position scratch returned by {@link syncEntities} (M8 · t8e). Its
 * fields are overwritten each frame the local body is present and the value is
 * consumed immediately by the audio listener + follow camera, so a single shared
 * object is safe and keeps the sample→sync→override hot path allocation-free.
 */
const localFeetScratch = { x: 0, y: 0, z: 0 };

/* -------------------------------------------------------------------------- */
/* Combat VFX — short-lived meshes spawned from server events                  */
/* -------------------------------------------------------------------------- */

/**
 * One live visual effect: a throwaway mesh that grows and/or spins as it ages
 * and fades out over its lifetime, after which it is removed and its geometry +
 * material are disposed. Each effect owns UNIQUE geometry (never a shared one), so
 * its disposal is always self-contained. {@link updateEffects} advances the pool.
 */
interface Effect {
  mesh: THREE.Mesh;
  /** Remaining lifetime in ms; the effect dies at <= 0. */
  ttl: number;
  /** Initial lifetime in ms, for the fade + growth curves. */
  maxTtl: number;
  /** Uniform scale added per ms of age (0 = hold size). */
  growPerMs: number;
  /** Yaw spin in radians per ms of frame time (0 = hold facing). */
  spinPerMs: number;
}

/** Live effect pool, advanced + culled every frame. */
const effects: Effect[] = [];

/**
 * Register a freshly built effect mesh: remember its starting uniform scale (the
 * growth curve multiplies it) and add it to the scene. `ttlMs` is its lifetime;
 * `grow`/`spin` shape its age animation.
 */
function addEffect(
  mesh: THREE.Mesh,
  ttlMs: number,
  grow: number,
  spin: number,
): void {
  mesh.userData.baseScale = mesh.scale.x;
  effects.push({ mesh, ttl: ttlMs, maxTtl: ttlMs, growPerMs: grow, spinPerMs: spin });
  scene.add(mesh);
}

/** Advance every effect by `dtMs`, fading + growing it, and reap the expired. */
function updateEffects(dtMs: number): void {
  for (let i = effects.length - 1; i >= 0; i -= 1) {
    const fx = effects[i];
    fx.ttl -= dtMs;
    if (fx.ttl <= 0) {
      scene.remove(fx.mesh);
      fx.mesh.geometry.dispose();
      (fx.mesh.material as THREE.Material).dispose();
      effects.splice(i, 1);
      continue;
    }
    const age = fx.maxTtl - fx.ttl;
    const life = fx.ttl / fx.maxTtl; // 1 -> 0 over the lifetime
    const baseScale = fx.mesh.userData.baseScale as number;
    fx.mesh.scale.setScalar(baseScale * (1 + fx.growPerMs * age));
    fx.mesh.rotation.y += fx.spinPerMs * dtMs;
    (fx.mesh.material as THREE.MeshBasicMaterial).opacity = life;
  }
}

/**
 * A translucent "swing sweep" laid flat on the ground in front of the swinger,
 * oriented by their facing `yaw`, that flares and fades over ~220 ms. Uses the
 * `YXZ` euler order so `yaw` spins about world-up *before* the sector is tilted
 * flat, keeping the arc pointed the way the attacker faces.
 */
function spawnSwingVfx(x: number, y: number, z: number, yaw: number): void {
  const geo = new THREE.CircleGeometry(1.4, 20, -1.2, 2.4); // ~137 deg sector
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffb347,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.order = 'YXZ';
  mesh.rotation.y = yaw;
  mesh.rotation.x = -Math.PI / 2; // lay the sector flat on the ground plane
  // Nudge the sweep forward of the swinger; forward(yaw) = (-sin, 0, -cos).
  mesh.position.set(x - Math.sin(yaw) * 0.6, y + 0.06, z - Math.cos(yaw) * 0.6);
  addEffect(mesh, 220, 0.0009, 0);
}

/** A bright spinning halo-ring over a stunned target that swells + fades (~320 ms). */
function spawnStunVfx(x: number, y: number, z: number): void {
  const geo = new THREE.TorusGeometry(0.35, 0.06, 8, 20);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffe14a,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2; // lie flat like a halo above the head
  mesh.position.set(x, y + 1.3, z);
  addEffect(mesh, 320, 0.0016, 0.02);
}

/** A sickly-green wireframe burst at a freshly infected victim (~460 ms). */
function spawnInfectVfx(x: number, y: number, z: number): void {
  const geo = new THREE.IcosahedronGeometry(0.5, 0);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x76ff5a,
    wireframe: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y + 0.9, z);
  addEffect(mesh, 460, 0.004, 0.012);
}

/* -------------------------------------------------------------------------- */
/* Kill / turn feed — now the {@link KillFeed} module (M16 · t16d), constructed  */
/* up with the other M16 UI; `killFeed.push(...)` / `killFeed.update(dt)` below. */
/* -------------------------------------------------------------------------- */
/* HUD overlay — the round-loop heads-up display (status panel + banner)        */
/* -------------------------------------------------------------------------- */

/**
 * The round HUD (status panel + phase-driven round banner), mounted into the
 * same `#app` container as the renderer. Built once here and refreshed every
 * frame in {@link animate} from the connection's latest ROUND plus a little
 * local state (the team derived from the local entity, and {@link localReady}).
 */
const hud = new HUD(app);

/**
 * Resolve the local player's team from its interpolated entity `kind`, or `null`
 * if we haven't spawned yet (pre-WELCOME, or spectating). The HUD shows `—` for
 * a `null` team; the authoritative score comes from ROUND, not this.
 */
function localTeam(entities: Map<number, InterpolatedEntity>): EntityKind | null {
  const localId = connection.playerId;
  const me = localId !== null ? entities.get(localId) : undefined;
  return me ? me.kind : null;
}

/**
 * Resolve the local player's server-authoritative stamina fraction (0..1) from
 * its interpolated entity, or `null` if we haven't spawned yet (pre-WELCOME, or
 * spectating). The HUD draws an empty, neutral bar for `null`.
 */
function localStamina(entities: Map<number, InterpolatedEntity>): number | null {
  const localId = connection.playerId;
  const me = localId !== null ? entities.get(localId) : undefined;
  return me ? me.stamina : null;
}

/* -------------------------------------------------------------------------- */
/* Perf overlay — toggleable frame-budget readout (M8 · t8e)                   */
/* -------------------------------------------------------------------------- */

/**
 * Target per-frame budget in milliseconds. A *stable* frame time at
 * {@link CLIENT_FPS} — not a high peak fps — is what makes walking read as smooth,
 * so this is the number the overlay's p95 is checked against. At 60 fps ≈ 16.7 ms.
 */
const FRAME_BUDGET_MS = 1000 / CLIENT_FPS;

/**
 * How often (ms) the perf overlay recomputes its stats and repaints while visible.
 * The per-frame cost is just one ring-buffer write; the copy+sort for p95 and the
 * DOM paint happen only this often, so the overlay itself never distorts the
 * frame budget it is measuring.
 */
const PERF_REFRESH_MS = 250;

/**
 * A toggleable performance overlay (M8 · t8e): live FPS, mean + p95 frame time
 * (vs. {@link FRAME_BUDGET_MS}), and draw-call / triangle counts pulled from
 * `renderer.info` after each render. Hidden by default; the backtick key (`)
 * toggles it. It keeps a small ring of recent frame times so the p95 reflects the
 * GC hitches a mean would hide — a flat p95 near the budget is the t8e goal.
 */
class PerfOverlay {
  private readonly el: HTMLDivElement;
  private readonly frames: number[];
  private head = 0;
  private count = 0;
  private sinceRefreshMs = 0;
  private visible = false;

  constructor(parent: HTMLElement, private readonly capacity = 120) {
    this.frames = new Array<number>(capacity).fill(0);
    this.el = document.createElement('div');
    Object.assign(this.el.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      padding: '8px 12px',
      font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: '#bfe6c9',
      background: 'rgba(5, 7, 10, 0.72)',
      border: '1px solid rgba(58, 106, 74, 0.5)',
      borderRadius: '6px',
      pointerEvents: 'none',
      userSelect: 'none',
      whiteSpace: 'pre',
      backdropFilter: 'blur(2px)',
      zIndex: '20',
    } satisfies Partial<CSSStyleDeclaration>);
    this.el.style.display = 'none';
    parent.appendChild(this.el);
  }

  /** Show/hide the overlay (bound to the backtick key in the input wiring). */
  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  /**
   * Record this frame's time and, while visible, refresh the readout (throttled to
   * {@link PERF_REFRESH_MS}) from `renderer.info`. Recording is two cheap writes;
   * the sort + DOM paint run only on the throttled refresh, and nothing runs at
   * all while hidden beyond the ring write.
   */
  update(dtMs: number, info: THREE.WebGLInfo): void {
    this.frames[this.head] = dtMs;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;

    if (!this.visible) return;
    this.sinceRefreshMs += dtMs;
    if (this.sinceRefreshMs < PERF_REFRESH_MS) return;
    this.sinceRefreshMs = 0;

    let sum = 0;
    for (let i = 0; i < this.count; i += 1) sum += this.frames[i];
    const mean = this.count > 0 ? sum / this.count : 0;
    const fps = mean > 0 ? 1000 / mean : 0;

    // p95 over the window — the copy + sort only run at the throttled cadence.
    const sorted = this.frames.slice(0, this.count).sort((a, b) => a - b);
    const p95 =
      sorted.length > 0
        ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
        : 0;
    const over = p95 > FRAME_BUDGET_MS;

    this.el.innerHTML =
      `<div>fps ${fps.toFixed(0)}  ·  frame ${mean.toFixed(1)}ms</div>` +
      `<div style="color:${over ? '#ff8f6b' : '#bfe6c9'}">` +
      `p95 ${p95.toFixed(1)}ms / ${FRAME_BUDGET_MS.toFixed(1)}ms budget</div>` +
      `<div>draws ${info.render.calls}  ·  tris ${info.render.triangles.toLocaleString()}</div>`;
  }

  /** Detach the overlay element (page teardown). */
  dispose(): void {
    this.el.remove();
  }
}

/** The perf overlay, hidden until the backtick key toggles it (see input wiring). */
const perf = new PerfOverlay(app);

/**
 * Backtick (`) toggles the perf overlay (M8 · t8e). Bound on `window` so it works
 * with or without pointer lock, and `repeat` is ignored so a held key doesn't
 * strobe it — mirroring the `R` ready toggle above.
 */
window.addEventListener('keydown', (ev) => {
  if (ev.code !== 'Backquote' || ev.repeat) return;
  perf.toggle();
});

/**
 * `P` toggles the M14 post-processing chain (bloom + horror grade) on/off, so
 * its cost/look can be A/B'd against the raw render. Mirrors the perf overlay's
 * backtick binding: window-level so it works with or without pointer lock, and
 * `repeat` is ignored so a held key doesn't strobe it.
 */
window.addEventListener('keydown', (ev) => {
  if (ev.code !== 'KeyP' || ev.repeat) return;
  postFx.enabled = !postFx.enabled;
  // Keep the settings store in step so the options menu reflects the `P` toggle.
  settings.set('postProcessing', postFx.enabled);
});

/**
 * M15 UX shortcuts, all window-level so they work with or without pointer lock:
 *   - `Tab` (held) shows the scoreboard/roster; released hides it. `preventDefault`
 *     stops the browser stealing the key for focus traversal.
 *   - `O` toggles the options/settings modal.
 *   - `N` toggles the minimap via the settings store (single source of truth), so
 *     the options menu's minimap switch and this shortcut always agree.
 * `repeat` is ignored on the toggles so a held key can't strobe them.
 */
window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Tab') {
    ev.preventDefault();
    scoreboard.setVisible(true);
    return;
  }
  if (ev.repeat) return;
  if (ev.code === 'KeyO') settingsMenu.toggle();
  else if (ev.code === 'KeyN') settings.set('minimap', !settings.get('minimap'));
  // M16: `H` (or `?`) toggles the controls/help reference overlay.
  else if (ev.code === 'KeyH' || ev.key === '?') helpOverlay.toggle();
});
window.addEventListener('keyup', (ev) => {
  if (ev.code === 'Tab') scoreboard.setVisible(false);
});

/* -------------------------------------------------------------------------- */
/* Resize handling                                                            */
/* -------------------------------------------------------------------------- */

function onResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  // M14: resize the post-processing composer + its render targets to match.
  postFx.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

/* -------------------------------------------------------------------------- */
/* Footstep driver — a positional step per moving entity, on a speed cadence    */
/* -------------------------------------------------------------------------- */

/** Milliseconds between footsteps per movement state (run < walk < crawl). */
const FOOTSTEP_INTERVAL_MS: Readonly<Record<'walk' | 'run' | 'crawl', number>> = {
  walk: 430,
  run: 300,
  crawl: 640,
};

/**
 * Per-entity footstep accumulators (ms of movement since the last step). Seeded
 * with an id-derived phase so a crowd of walkers doesn't march in lock-step, and
 * pruned as entities stop moving or leave.
 */
const footstepTimers = new Map<number, number>();

/**
 * Last movement/action state seen per entity (t12b), so {@link driveFootsteps}
 * can detect the return-to-ground edge (leaving the `'jump'` state) and fire a
 * land thud. Pruned alongside the footstep timers.
 */
const prevEntityState = new Map<number, InterpolatedEntity['state']>();

/**
 * Chebyshev distance (m) at/beyond which the ground reads as the perimeter
 * forest band rather than town paving — matches shared's `FOREST_BAND_INNER`
 * (`TOWN_HALF + 4 ≈ 58`), the inner edge of the tree wall. Steps out here play
 * as soft `'dirt'`; see {@link surfaceForStep}.
 */
const FOREST_SURFACE_EDGE = 58;

/** How close to the shoreline (m) a step counts as `'wet'` — roughly one stride. */
const WATER_SURFACE_MARGIN = 2.5;

/**
 * Pick the footstep surface for a world position from {@link world} data (t12b):
 * within a stride of the lake edge → `'wet'`; out in the perimeter forest band →
 * `'dirt'`; otherwise the town's hard `'stone'` paving. Cheap: a couple of
 * comparisons and, when a lake exists, one distance check.
 */
function surfaceForStep(x: number, z: number): FootstepSurface {
  if (world !== null) {
    const lake = world.water;
    if (lake !== null) {
      const dx = x - lake.cx;
      const dz = z - lake.cz;
      if (Math.hypot(dx, dz) <= lake.radius + WATER_SURFACE_MARGIN) return 'wet';
    }
    if (Math.max(Math.abs(x), Math.abs(z)) >= FOREST_SURFACE_EDGE) return 'dirt';
  }
  return 'stone';
}

/**
 * The world position at which to play a **non-positional** cue (round horn / end
 * sting / lobby blip) so it lands centred on the player: the local entity's own
 * position when we have one, else the world origin. Routed through the same
 * positional {@link AudioEngine.oneShot} spine, it reads as pan ≈ 0, gain ≈ 1.
 */
function listenerAnchor(entities: Map<number, InterpolatedEntity>): Point3 {
  const me = connection.playerId !== null ? entities.get(connection.playerId) : undefined;
  return me ?? { x: 0, y: 0, z: 0 };
}

/**
 * Emit positional footsteps for every entity in a movement state, including the
 * local player (also drawn from server state until prediction lands). Each
 * entity accrues frame time and fires a step when it crosses its speed-dependent
 * interval; the {@link AudioEngine} culls anything out of earshot, so distant
 * hordes cost only the cheap bookkeeping here. Steps are surface-flavoured by
 * {@link surfaceForStep}. Also drives both the take-off whoosh and the land thud
 * off the `'jump'` state edges: the server never emits a `'jump'` *event* (only
 * attack/stun/infect/roundStart/roundEnd), so `'jump'` is observed purely as a
 * snapshot movement state, and both cues ride its enter/leave transitions here.
 */
function driveFootsteps(
  entities: Map<number, InterpolatedEntity>,
  dtMs: number,
): void {
  for (const entity of entities.values()) {
    const s = entity.state;

    // Jump cues off the 'jump' state edges (there is no server 'jump' event):
    // entering 'jump' is a take-off whoosh, leaving it is a touch-down thud —
    // positional, for everyone, local + remote. The `prev !== undefined` guard
    // skips a spurious whoosh for an entity first sighted already mid-jump.
    const prev = prevEntityState.get(entity.id);
    if (prev !== undefined && prev !== 'jump' && s === 'jump') audio.jump(entity);
    else if (prev === 'jump' && s !== 'jump') {
      audio.land(entity);
      // M14: a camera landing punch when the LOCAL player touches down.
      if (entity.id === connection.playerId) cameraShake.landingPunch();
    }
    prevEntityState.set(entity.id, s);

    if (s !== 'walk' && s !== 'run' && s !== 'crawl') {
      footstepTimers.delete(entity.id);
      continue;
    }
    const interval = FOOTSTEP_INTERVAL_MS[s];
    // First sighting: start part-way through the cadence (id-derived phase) so
    // steps land immediately and multiple movers stay out of phase.
    let t = footstepTimers.get(entity.id) ?? (entity.id * 137) % interval;
    t += dtMs;
    if (t >= interval) {
      audio.footstep(entity, s, surfaceForStep(entity.x, entity.z));
      t -= interval;
    }
    footstepTimers.set(entity.id, t);
  }
  // Drop timers + state for entities that have left the world entirely.
  for (const id of footstepTimers.keys()) {
    if (!entities.has(id)) footstepTimers.delete(id);
  }
  for (const id of prevEntityState.keys()) {
    if (!entities.has(id)) prevEntityState.delete(id);
  }
}

/* -------------------------------------------------------------------------- */
/* Zombie vocalisation scheduler — occasional groans/snarls, throttled          */
/* -------------------------------------------------------------------------- */

/** Minimum gap (ms) between ANY two zombie vocalisations — a global throttle so a horde never clips. */
const ZOMBIE_VOICE_MIN_GAP_MS = 260;
/** A zombie's vocalisation cadence window (ms): the next attempt is scheduled this far out. */
const ZOMBIE_VOICE_MIN_MS = 3800;
const ZOMBIE_VOICE_MAX_MS = 9000;
/** Zombies beyond this (m) from the listener stay silent, so a distant horde never spends the global slot. */
const ZOMBIE_VOICE_RANGE_M = 40;
/** Chance a due vocalisation is the aggressive snarl rather than the low idle groan. */
const ZOMBIE_SNARL_CHANCE = 0.28;

/** Per-zombie countdown (ms) to its next vocalisation attempt; id-phased on first sighting. */
const zombieVoiceTimers = new Map<number, number>();
/** Global cooldown (ms) shared across the whole horde; caps how often ANY zombie speaks. */
let zombieVoiceCooldownMs = 0;

/**
 * Sparse, throttled zombie chatter (t12b): each zombie counts down an id-phased
 * timer and, when due AND within earshot AND the shared cooldown has elapsed,
 * emits a low groan (usually) or an aggro snarl (occasionally) at its own
 * position, then reschedules a few seconds out. The global {@link
 * zombieVoiceCooldownMs} plus the distance gate keep a busy horde from spamming
 * or clipping — at most one voice per {@link ZOMBIE_VOICE_MIN_GAP_MS}. Out-of-
 * earshot or cooldown-blocked zombies simply requeue soon and stay silent.
 */
function driveZombieVoices(
  entities: Map<number, InterpolatedEntity>,
  dtMs: number,
  listener: Point3,
): void {
  zombieVoiceCooldownMs -= dtMs;
  for (const entity of entities.values()) {
    if (entity.kind !== 'zombie') {
      zombieVoiceTimers.delete(entity.id);
      continue;
    }
    // First sighting: id-derived phase so a spawned horde doesn't all groan at once.
    let t =
      zombieVoiceTimers.get(entity.id) ??
      ZOMBIE_VOICE_MIN_MS + ((entity.id * 911) % (ZOMBIE_VOICE_MAX_MS - ZOMBIE_VOICE_MIN_MS));
    t -= dtMs;
    if (t <= 0) {
      const dx = entity.x - listener.x;
      const dz = entity.z - listener.z;
      if (dx * dx + dz * dz > ZOMBIE_VOICE_RANGE_M * ZOMBIE_VOICE_RANGE_M) {
        // Out of earshot: stay quiet, don't spend the global slot, check back soon.
        t = 900 + Math.random() * 1400;
      } else if (zombieVoiceCooldownMs > 0) {
        // Horde already speaking this window: retry shortly rather than overlap.
        t = 120 + Math.random() * 200;
      } else {
        if (Math.random() < ZOMBIE_SNARL_CHANCE) audio.zombieSnarl(entity);
        else audio.zombieGroan(entity);
        zombieVoiceCooldownMs = ZOMBIE_VOICE_MIN_GAP_MS;
        t = ZOMBIE_VOICE_MIN_MS + Math.random() * (ZOMBIE_VOICE_MAX_MS - ZOMBIE_VOICE_MIN_MS);
      }
    }
    zombieVoiceTimers.set(entity.id, t);
  }
  // Drop schedules for zombies that have left the world entirely.
  for (const id of zombieVoiceTimers.keys()) {
    if (!entities.has(id)) zombieVoiceTimers.delete(id);
  }
}

/* -------------------------------------------------------------------------- */
/* Fixed-timestep input pump (M8 · t8a + t8c)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Fixed input/prediction sub-step in seconds — the EXACT tick the server
 * integrates (`DT = TICK_MS / 1000` in `Room.ts`). Every INPUT frame is sent, and
 * every predictor {@link Predictor.record}, uses this `dt` rather than the variable
 * render delta, so the client sim advances byte-for-byte with the authority and no
 * longer drifts between reconciles (t8a).
 */
const INPUT_DT_SEC = TICK_MS / 1000;

/**
 * Maximum fixed input sub-steps pumped per render frame — mirrors the server's
 * `MAX_CATCHUP_STEPS`. Caps catch-up so a stalled/backgrounded tab that wakes with
 * a huge render delta can't spiral out a burst of inputs; the backlog beyond the
 * cap is dropped (see {@link inputAccumulatorMs}).
 */
const MAX_INPUT_SUBSTEPS = 5;

/**
 * Leftover render time (ms) not yet consumed by a fixed sub-step, carried across
 * frames so no motion is dropped or double-counted — the server's accumulator,
 * client-side. Each frame adds the render delta; the pump drains it one
 * {@link TICK_MS} at a time and the sub-tick remainder (`< TICK_MS`) rolls forward.
 */
let inputAccumulatorMs = 0;

/**
 * Held-key bitmask OR-accumulated across EVERY render frame since the last INPUT
 * send (t8c). Because INPUT now emits once per fixed sub-step (~TICK_RATE) rather
 * than once per render frame, a key TAP that goes down and back up entirely
 * between two sends would otherwise be lost; OR-ing each render frame's
 * {@link Controls.keys} in here guarantees the press is seen. It is consumed at
 * each send and reset to the currently-held keys so held keys persist.
 */
let accumulatedKeys = 0;

/* -------------------------------------------------------------------------- */
/* Music intensity (M12 · t12c)                                               */
/* -------------------------------------------------------------------------- */

/** Clamp `x` into the inclusive range [0, 1]. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/* -------------------------------------------------------------------------- */
/* M14 — game-feel helpers (proximity-scaled camera trauma + danger vignette)  */
/* -------------------------------------------------------------------------- */

/** Full camera trauma for a point-blank event; fades to 0 by this range (m). */
const PROXIMITY_TRAUMA_FALLOFF_M = 14;
/** Cap on the trauma a nearby (non-local) event may add. */
const PROXIMITY_TRAUMA_MAX = 0.35;
/** Nearest-zombie distance (m) at/under which the danger vignette is full. */
const DANGER_NEAR_M = 3;
/** Nearest-zombie distance (m) at/beyond which the danger vignette is off. */
const DANGER_FAR_M = 12;

/**
 * A small camera-shake amount (0..{@link PROXIMITY_TRAUMA_MAX}) for an event at
 * world (x, z), scaled by how close it happened to the local player - so a
 * distant scuffle barely registers while a fight in your face rattles the lens.
 * Zero if we have no body yet.
 */
function traumaByProximity(
  x: number,
  z: number,
  entities: Map<number, InterpolatedEntity>,
): number {
  const localId = connection.playerId;
  const me = localId !== null ? entities.get(localId) : undefined;
  if (me === undefined) return 0;
  const dx = x - me.x;
  const dz = z - me.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  return PROXIMITY_TRAUMA_MAX * clamp01((PROXIMITY_TRAUMA_FALLOFF_M - d) / PROXIMITY_TRAUMA_FALLOFF_M);
}

/**
 * Rising 0..1 'danger' intensity as the nearest zombie closes on a HUMAN local
 * player, mapped from {@link DANGER_FAR_M} (0) to {@link DANGER_NEAR_M} (1).
 * Zero when we're the zombie (turned), have no body, or the map is zombie-free.
 */
function dangerIntensity(
  entities: Map<number, InterpolatedEntity>,
  localFeet: { x: number; y: number; z: number } | null,
): number {
  if (localFeet === null || localTeam(entities) !== 'human') return 0;
  let nearestSq = Infinity;
  for (const e of entities.values()) {
    if (e.kind !== 'zombie') continue;
    const dx = e.x - localFeet.x;
    const dz = e.z - localFeet.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < nearestSq) nearestSq = d2;
  }
  if (nearestSq === Infinity) return 0;
  const d = Math.sqrt(nearestSq);
  return clamp01((DANGER_FAR_M - d) / (DANGER_FAR_M - DANGER_NEAR_M));
}

/**
 * Map the current {@link RoundMessage} to a musical intensity in [0, 1] for the
 * {@link AudioEngine.setMusicIntensity dynamic music bed}:
 *
 *  - no round / `lobby` → calm (0),
 *  - `countdown` → a faint pre-match unease (0.15),
 *  - `active` → the greater of two pressures, so either can drive the dread:
 *      • *attrition* — how far the humans have been overrun
 *        (`1 - humansAlive / (humansAlive + zombieCount)`), and
 *      • *the clock* — how much of the round has elapsed,
 *    lifted onto a 0.25 floor so play always feels tenser than the lobby,
 *  - `ended` → a held spike (0.95).
 *
 * The engine smooths every change internally, so this can be recomputed and
 * pushed each frame without any risk of a click.
 */
function roundMusicIntensity(round: RoundMessage | null): number {
  if (round === null) return 0;
  switch (round.phase) {
    case 'countdown':
      return 0.15;
    case 'active': {
      const total = round.humansAlive + round.zombieCount;
      const attrition = total > 0 ? 1 - round.humansAlive / total : 0;
      const elapsed = 1 - clamp01(round.timeLeftMs / ROUND_LENGTH_MS);
      return clamp01(0.25 + 0.75 * Math.max(attrition, elapsed));
    }
    case 'ended':
      return 0.95;
    case 'lobby':
    default:
      return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Render loop                                                                */
/* -------------------------------------------------------------------------- */

const clock = new THREE.Clock();

function animate(): void {
  const dt = clock.getDelta();
  const dtMs = dt * 1000;
  const now = performance.now();

  // 1. Build the town once we know the seed (the fixed pump below records into
  //    the predictor, which needs the town for the same XZ collision as the server).
  ensureWorld();

  // 1b. Fixed-timestep INPUT + prediction pump (t8a/t8c). Accumulate this frame's
  //     render time and advance in fixed TICK_MS sub-steps, mirroring the server's
  //     accumulator. Each sub-step sends ONE input (allocating its seq) and records
  //     that SAME seq into the predictor with the fixed dt, so INPUT rate tracks the
  //     tick rate (not the frame rate) and the server ack/predictor replay align.
  //     A key TAP between two sends is preserved via the OR-accumulated mask.
  accumulatedKeys |= controls.keys; // fold this render frame's held/tapped keys
  inputAccumulatorMs += dtMs;
  let inputSteps = 0;
  while (inputAccumulatorMs >= TICK_MS && inputSteps < MAX_INPUT_SUBSTEPS) {
    const keys = accumulatedKeys; // consume presses seen since the last send
    const yaw = controls.yaw; // latest look yaw at send time
    const seq = connection.sendInput(keys, INPUT_DT_SEC, yaw);
    // Mirror the same input into the predictor (guarded by the town, as before);
    // still send even before the world exists so seq stays continuous.
    if (world !== null) {
      predictor.record(seq, keys, yaw, INPUT_DT_SEC, world);
    }
    accumulatedKeys = controls.keys; // reset to still-held keys (held ones persist)
    inputAccumulatorMs -= TICK_MS;
    inputSteps += 1;
  }
  // Hit the cap with time still owed: drop the backlog rather than chase it,
  // exactly like the server's pump, so a long stall can't spiral.
  if (inputSteps === MAX_INPUT_SUBSTEPS && inputAccumulatorMs > TICK_MS) {
    inputAccumulatorMs = 0;
  }

  // 3. Sample the interpolated world once; reused for events, meshes, and HUD.
  const entities = connection.sampleEntities(now);

  // 3b. Reconcile the predictor once per new authoritative snapshot: snap onto the
  //     server's local-player state, drop acked inputs, replay the unacked tail.
  if (
    world !== null &&
    connection.playerId !== null &&
    connection.tick !== lastReconciledTick
  ) {
    const serverLocal = connection.entities.get(connection.playerId);
    if (serverLocal !== undefined) {
      predictor.reconcile(serverLocal, connection.ack, world);
      lastReconciledTick = connection.tick;
    }
  }

  // 3b-smooth. Advance the reconciliation error-smoothing offset by this render
  //     frame (t8b). Done once per RENDER frame — the fixed prediction sub-steps in
  //     step 1b no longer run every frame — and BEFORE reading `predictor.predicted`
  //     below, so the smoothed offset is current for this frame's draw.
  predictor.decayOffset(dtMs);

  // 3c. Render override (upstream of syncEntities so that module stays decoupled):
  //     replace ONLY the local entity's transform with the predicted values (which
  //     already include the smoothing offset), leaving its kind/state — and every
  //     remote entity — interpolated as before.
  if (predictor.hasBase && connection.playerId !== null) {
    const me = entities.get(connection.playerId);
    if (me !== undefined) {
      const p = predictor.predicted;
      me.x = p.x;
      me.y = p.y;
      me.z = p.z;
      me.yaw = p.yaw;
    }
  }

  // 4. Turn this frame's server events into VFX + turn-feed lines. Positions
  //    fall back to the actor/target entity when an event omits coordinates.
  for (const ev of connection.drainEvents()) {
    switch (ev.kind) {
      case 'attack': {
        const src = ev.actorId !== undefined ? entities.get(ev.actorId) : undefined;
        const x = ev.x ?? src?.x ?? 0;
        const y = ev.y ?? src?.y ?? 0;
        const z = ev.z ?? src?.z ?? 0;
        spawnSwingVfx(x, y, z, src?.yaw ?? 0);
        // M14: a small FOV kick when it's YOUR swing, for weight.
        if (ev.actorId === connection.playerId) cameraShake.kickFov(3);
        // A zombie's attack is a claw swipe; a human's is the bat whoosh (t12b).
        if (src?.kind === 'zombie') audio.zombieClaw({ x, y, z });
        else audio.swing({ x, y, z });
        break;
      }
      case 'stun': {
        const tgt = ev.targetId !== undefined ? entities.get(ev.targetId) : undefined;
        const x = ev.x ?? tgt?.x ?? 0;
        const y = ev.y ?? tgt?.y ?? 0;
        const z = ev.z ?? tgt?.z ?? 0;
        spawnStunVfx(x, y, z);
        // M14: bat-impact sparks at the victim + a camera punch. A hit YOU
        // landed (or took) rattles hardest; otherwise it falls off with range.
        particles.sparks(x, y, z);
        if (ev.actorId === connection.playerId) {
          cameraShake.addTrauma(0.5);
          cameraShake.kickFov(4);
        } else if (ev.targetId === connection.playerId) {
          cameraShake.addTrauma(0.6);
        } else {
          cameraShake.addTrauma(traumaByProximity(x, z, entities));
        }
        audio.hit({ x, y, z }); // bat-hit impact at the victim
        killFeed.push(`#${ev.actorId ?? '?'} stunned #${ev.targetId ?? '?'} 🦇`);
        break;
      }
      case 'infect': {
        const tgt = ev.targetId !== undefined ? entities.get(ev.targetId) : undefined;
        const x = ev.x ?? tgt?.x ?? 0;
        const y = ev.y ?? tgt?.y ?? 0;
        const z = ev.z ?? tgt?.z ?? 0;
        spawnInfectVfx(x, y, z);
        // M14: a spore burst at the victim; if it was YOU, a hard shake + the
        // full-screen infection flash - otherwise a proximity-scaled jolt.
        particles.spores(x, y, z);
        if (ev.targetId === connection.playerId) {
          screenFx.infected();
          turnOverlay.trigger(); // M17: the "you have been turned" moment splash
          cameraShake.addTrauma(0.8);
        } else {
          cameraShake.addTrauma(traumaByProximity(x, z, entities));
        }
        audio.infect({ x, y, z }); // infection stinger at the victim
        audio.duck(); // dip music/ambient so the stinger reads (t12e)
        killFeed.push(`Player #${ev.targetId ?? '?'} was turned 🧟`);
        break;
      }
      case 'roundStart': {
        // A rising horn to open the match. Non-positional: centred on the player.
        audio.roundStart(listenerAnchor(entities));
        cameraShake.addTrauma(0.25); // M14: a light jolt on the opening horn.
        audio.duck(); // dip the beds so the opening horn reads (t12e)
        break;
      }
      case 'roundEnd': {
        // A closing sting, varied by who won (bright human triad vs dark zombie
        // cluster). Winner rides on the ROUND message, not the event itself.
        audio.roundEnd(listenerAnchor(entities), connection.round?.winner);
        cameraShake.addTrauma(0.3); // M14: a heavier jolt on the closing sting.
        audio.duck(0.28); // deeper dip so the closing sting lands (t12e)
        break;
      }
      default:
        break;
    }
  }

  // 5. Reconcile meshes with the interpolated world; get the local player's pos.
  const localFeet = syncEntities(entities, now);

  // 5b. Audio: anchor the listener to the local player (facing = look yaw) and
  //     drive positional footsteps for everyone moving. Skipped until we have a
  //     local body, since positional panning/attenuation needs a reference point.
  if (localFeet !== null) {
    audio.setListener(localFeet, controls.yaw);
    driveFootsteps(entities, dtMs);
    driveZombieVoices(entities, dtMs, localFeet);
  }

  // 5c. Music: drive the dynamic-intensity bed off the round state (M12 · t12c).
  //     Calm in the lobby/countdown; during play, tenser as the humans dwindle
  //     and the clock winds down; a held spike at the end. The engine smooths
  //     every change internally, so pushing a fresh target each frame is fine.
  audio.setMusicIntensity(roundMusicIntensity(connection.round));

  // 5d. Audio: environment atmosphere (M12 · t12d). Occasional, subtle,
  //     positional one-shots — distant howls/wind, forest creaks/leaves, and
  //     water lapping at the lake — chosen from the seeded world features and
  //     biased to the listener's earshot. Gated on a local body (so the
  //     listener is anchored) and the town existing (so features are known).
  if (localFeet !== null && world !== null) {
    audio.updateEnvironment(dtMs, world);
  }

  // 6. Advance transient combat VFX and the turn feed, culling the expired.
  updateEffects(dtMs);
  killFeed.update(dtMs);
  // M17: age the momentary round-presentation overlays (each a no-op while hidden).
  turnOverlay.update(dtMs);
  roundIntro.update(dtMs);

  // 6b. Ripple the lake surface (M9 · t9d) — a cheap UV scroll, no allocations.
  water?.update(dtMs);

  // 6c. M14: advance the pooled particle system + the screen-space feedback
  //     overlay. The danger vignette rises as the nearest zombie closes on a
  //     HUMAN local player (0 when we're a zombie or have no body yet).
  particles.update(dtMs);
  screenFx.danger(dangerIntensity(entities, localFeet));
  screenFx.update(dtMs);

  // 6d. M15: advance the HUD/UX overlays. Each is a cheap no-op while hidden
  //     (minimap/scoreboard early-return unless shown), so calling them every
  //     frame is fine. The minimap centers on the local player and faces its
  //     look yaw; the scoreboard reads the roster + ROUND; the reticle tracks
  //     the swing cooldown and shows a phase/team objective while playing.
  minimap.update(world, entities, connection.playerId, controls.yaw);
  scoreboard.update(entities, connection.playerId, connection.round);
  reticle.update(dtMs, {
    round: connection.round,
    team: localTeam(entities),
    pointerLocked: controls.pointerLocked,
  });
  // M17: the end-of-round results screen — visible only while phase === 'ended'.
  roundEndScreen.update({ round: connection.round, team: localTeam(entities) });

  // 7. Drive the third-person camera when we have a local body and the town.
  if (localFeet !== null && world !== null) {
    follow.update(localFeet, controls.yaw, world, dt);
    // M14: layer camera juice (shake + FOV kick + landing dip) as a
    // non-accumulating offset - follow.update fully rewrote the transform
    // above, so next frame wipes it clean.
    cameraShake.apply(dtMs);
  }

  // 8. Refresh the round HUD from the latest ROUND + connection/local state.
  //    On every transition BACK into the lobby, clear our local ready flag to
  //    match the server (which drops all readiness on a round reset), so the
  //    HUD never shows "ready" carried over from the previous match.
  const round = connection.round;
  const phase = round?.phase ?? null;
  if (phase === 'lobby' && lastPhase !== 'lobby') localReady = false;
  // M17: fire the one-time role-reveal intro the frame a round goes active.
  if (phase === 'active' && lastPhase !== 'active') roundIntro.trigger(localTeam(entities));
  lastPhase = phase;

  hud.update({
    round,
    status: connection.status,
    playerId: connection.playerId,
    rttMs: connection.rttMs,
    tick: connection.tick,
    team: localTeam(entities),
    stamina: localStamina(entities),
    ready: localReady,
    lookHint: controls.pointerLocked
      ? 'Esc: menu · H: controls'
      : 'click to look · H: controls',
  });

  // M14: reset renderer.info once here (autoReset is off, see setup) so it
  // accumulates across every post-processing pass for a true per-frame total.
  renderer.info.reset();
  // M14: render through the post-processing chain (bloom + horror grade)
  // instead of a bare renderer.render; OutputPass applies the M11 ACES + sRGB
  // at the end. `P` toggles it off (postFx.enabled=false) for the raw render.
  postFx.render(dtMs);

  // 9. Sample the perf overlay AFTER the draw so `renderer.info` reflects this
  //    frame's draw calls / triangles (M8 · t8e). Records the frame time every
  //    frame; only repaints (throttled) while the overlay is toggled on.
  perf.update(dtMs, renderer.info);
}

renderer.setAnimationLoop(animate);

// Clean teardown on navigation so timers/sockets don't leak.
window.addEventListener('beforeunload', () => {
  connection.close();
  controls.dispose();
  hud.dispose();
  audioControls.dispose();
  audio.dispose();
  perf.dispose();
  // M9 (t9d/t9e): free the environment + lake surface GPU resources.
  if (environment !== null) disposeEnvironment(environment);
  water?.dispose();
  // M14: free the VFX / post-processing resources.
  postFx.dispose();
  particles.dispose();
  cameraShake.dispose();
  screenFx.dispose();
  // M15: free the HUD/UX overlays + the settings subscription.
  minimap.dispose();
  scoreboard.dispose();
  reticle.dispose();
  settingsMenu.dispose();
  unsubscribeSettings();
  settings.dispose();
  // M16: free the menus & onboarding overlays.
  titleScreen.dispose();
  helpOverlay.dispose();
  pauseMenu.dispose();
  killFeed.dispose();
  // M17: free the round-presentation overlays + the reduced-motion subscription.
  roundEndScreen.dispose();
  turnOverlay.dispose();
  roundIntro.dispose();
  unsubscribeReducedMotion();
});
