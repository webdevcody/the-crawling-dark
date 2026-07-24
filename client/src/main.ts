/**
 * The Crawling Dark — client entry point (M3 · Combat & Infection demo).
 *
 * Wires the M2 systems into a playable third-person scene:
 *   - the seeded town ({@link buildTown}) rendered from the same {@link World}
 *     the server collides against, rebuilt on the client from WELCOME's `mapSeed`;
 *   - keyboard + pointer-lock mouse look ({@link Controls}) packed into INPUT
 *     frames (held-key bitmask + look yaw) streamed every frame;
 *   - a third-person spring-arm follow camera ({@link FollowCamera}) that trails
 *     the local player and retracts around walls;
 *   - remote (and local) entities rendered from interpolated snapshots
 *     (~INTERP_BUFFER_MS in the past) so everyone moves smoothly.
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
 * There is no client-side prediction yet — the local player is also drawn from
 * interpolated server state, so it lags input slightly. Prediction/reconciliation
 * is M6 (t6a); until then this is the interpolation-only MVP the design calls for.
 */

import * as THREE from 'three';
import {
  MAP_SIZE,
  generateWorld,
  type World,
  type EntityKind,
} from '@crawling-dark/shared';
import { Connection } from './net/Connection';
import { Controls } from './input/Controls';
import { FollowCamera } from './scene/FollowCamera';
import { buildTown } from './scene/TownView';
import { Character } from './entities/Character';
import {
  configureRenderer,
  createAtmosphere,
  addStreetLights,
} from './scene/Atmosphere';
import { HUD } from './ui/HUD';
import type { InterpolatedEntity } from './net/Interpolation';

const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;

/* -------------------------------------------------------------------------- */
/* Renderer                                                                   */
/* -------------------------------------------------------------------------- */

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// M6 (t6e): enable the moon's soft shadow map (see Atmosphere.ts).
configureRenderer(renderer);
app.appendChild(renderer.domElement);

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

const scene = new THREE.Scene();
// M6 (t6e): the whole mood pass — near-black background + close tense fog, one
// dim cool ambient, and the single shadow-casting moon — lives in Atmosphere.ts.
// This replaces the former inline background/fog and the ambient/moon block below.
createAtmosphere(scene);

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
/* Ground plane + grid                                                        */
/* -------------------------------------------------------------------------- */

const groundGeometry = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE);
groundGeometry.rotateX(-Math.PI / 2);
const groundMaterial = new THREE.MeshStandardMaterial({
  color: 0x141c26,
  roughness: 1,
  metalness: 0,
});
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

/**
 * Left-click to swing the bat. Pointer lock is requested by Controls on the
 * FIRST canvas click, and at that mousedown the pointer is not yet locked — so
 * that click only enters play and never swings. Every subsequent left-click
 * fires only while `pointerLocked` (i.e. actually playing), cleanly separating
 * click-to-play from click-to-swing without fighting the lock wiring. Right and
 * middle buttons are ignored.
 */
renderer.domElement.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  if (!controls.pointerLocked) return;
  connection.sendAttack();
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
  localReady = !localReady;
  connection.sendReady(localReady);
});

/** Last round phase we observed, to detect the transition back into `lobby`. */
let lastPhase: string | null = null;

/* -------------------------------------------------------------------------- */
/* Town — built once WELCOME's mapSeed arrives (identical to the server's)     */
/* -------------------------------------------------------------------------- */

/** The seeded town, once we know the seed; drives building meshes + camera collision. */
let world: World | null = null;

/** Build the town exactly once, as soon as the deterministic seed is known. */
function ensureWorld(): void {
  if (world !== null) return;
  const seed = connection.mapSeed;
  if (seed === null) return;
  world = generateWorld(seed);
  scene.add(buildTown(world));
  // M6 (t6e): warm sodium lamp posts along the streets, now that the town exists.
  addStreetLights(scene, world);
}

/* -------------------------------------------------------------------------- */
/* Entity characters — reconciled against interpolated snapshots each frame     */
/* -------------------------------------------------------------------------- */

/**
 * Live character rigs keyed by entity id, mirroring the interpolated entity set.
 * Each {@link Character} is an articulated humanoid built behind the
 * {@link CharacterModel} seam (see `entities/Character.ts`), so the box-per-body
 * renderer this replaced — and, later, a GLTF/AnimationMixer body — can be
 * swapped in without touching the reconciliation loop below.
 */
const characters = new Map<number, Character>();

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
  let localFeet: { x: number; y: number; z: number } | null = null;

  // Frame delta for the rigs, clamped so a stalled tab can't fling the pose.
  const dtMs = lastCharNowMs === 0 ? 0 : Math.min(100, Math.max(0, nowMs - lastCharNowMs));
  lastCharNowMs = nowMs;

  for (const entity of entities.values()) {
    const isLocal = entity.id === localId;

    let character = characters.get(entity.id);
    if (character === undefined) {
      character = new Character(entity.id);
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

    if (isLocal) localFeet = { x: entity.x, y: entity.y, z: entity.z };
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

  return localFeet;
}

/* -------------------------------------------------------------------------- */
/* Combat VFX — short-lived meshes spawned from server events                  */
/* -------------------------------------------------------------------------- */

/**
 * One live visual effect: a throwaway mesh that grows and/or spins as it ages
 * and fades out over its lifetime, after which it is removed and its geometry +
 * material are disposed. Each effect owns UNIQUE geometry, so disposal can never
 * touch the shared PLAYER_GEOMETRY. {@link updateEffects} advances the pool.
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
/* Kill / turn feed — a small stack of recent, self-expiring lines             */
/* -------------------------------------------------------------------------- */

/** How long a feed line stays up before it has fully faded, in ms. */
const FEED_TTL_MS = 6000;

/** Cap on feed lines kept on screen (newest win). */
const FEED_MAX_LINES = 5;

/** One turn-feed line with its own countdown; newest are unshifted to the top. */
interface FeedLine {
  text: string;
  ttl: number;
}

const feedLines: FeedLine[] = [];

const feed = document.createElement('div');
Object.assign(feed.style, {
  position: 'fixed',
  bottom: '12px',
  left: '12px',
  padding: '8px 12px',
  font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#e6d2d2',
  background: 'rgba(5, 7, 10, 0.72)',
  border: '1px solid rgba(106, 58, 58, 0.5)',
  borderRadius: '6px',
  pointerEvents: 'none',
  userSelect: 'none',
  whiteSpace: 'pre',
  backdropFilter: 'blur(2px)',
  maxWidth: '320px',
} satisfies Partial<CSSStyleDeclaration>);
feed.style.display = 'none'; // hidden until the first event lands
app.appendChild(feed);

/** Push a new line onto the turn feed, trimming to the newest {@link FEED_MAX_LINES}. */
function pushFeedLine(text: string): void {
  feedLines.unshift({ text, ttl: FEED_TTL_MS });
  if (feedLines.length > FEED_MAX_LINES) feedLines.length = FEED_MAX_LINES;
}

/** Age out feed lines and re-render (newest on top, each fading over its last second). */
function updateFeed(dtMs: number): void {
  for (let i = feedLines.length - 1; i >= 0; i -= 1) {
    feedLines[i].ttl -= dtMs;
    if (feedLines[i].ttl <= 0) feedLines.splice(i, 1);
  }
  if (feedLines.length === 0) {
    feed.style.display = 'none';
    return;
  }
  feed.style.display = 'block';
  feed.innerHTML = feedLines
    .map((line) => {
      const alpha = Math.min(1, line.ttl / 1000).toFixed(2);
      return `<div style="opacity:${alpha}">${line.text}</div>`;
    })
    .join('');
}

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
/* Resize handling                                                            */
/* -------------------------------------------------------------------------- */

function onResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

/* -------------------------------------------------------------------------- */
/* Render loop                                                                */
/* -------------------------------------------------------------------------- */

const clock = new THREE.Clock();

function animate(): void {
  const dt = clock.getDelta();
  const dtMs = dt * 1000;
  const now = performance.now();

  // 1. Push this frame's input (held-key bitmask + look yaw) to the server.
  connection.sendInput(controls.keys, dt, controls.yaw);

  // 2. Build the town once we know the seed.
  ensureWorld();

  // 3. Sample the interpolated world once; reused for events, meshes, and HUD.
  const entities = connection.sampleEntities(now);

  // 4. Turn this frame's server events into VFX + turn-feed lines. Positions
  //    fall back to the actor/target entity when an event omits coordinates.
  for (const ev of connection.drainEvents()) {
    switch (ev.kind) {
      case 'attack': {
        const src = ev.actorId !== undefined ? entities.get(ev.actorId) : undefined;
        spawnSwingVfx(
          ev.x ?? src?.x ?? 0,
          ev.y ?? src?.y ?? 0,
          ev.z ?? src?.z ?? 0,
          src?.yaw ?? 0,
        );
        break;
      }
      case 'stun': {
        const tgt = ev.targetId !== undefined ? entities.get(ev.targetId) : undefined;
        spawnStunVfx(ev.x ?? tgt?.x ?? 0, ev.y ?? tgt?.y ?? 0, ev.z ?? tgt?.z ?? 0);
        pushFeedLine(`#${ev.actorId ?? '?'} stunned #${ev.targetId ?? '?'} 🦇`);
        break;
      }
      case 'infect': {
        const tgt = ev.targetId !== undefined ? entities.get(ev.targetId) : undefined;
        spawnInfectVfx(ev.x ?? tgt?.x ?? 0, ev.y ?? tgt?.y ?? 0, ev.z ?? tgt?.z ?? 0);
        pushFeedLine(`Player #${ev.targetId ?? '?'} was turned 🧟`);
        break;
      }
      default:
        // jump / roundStart / roundEnd — no client VFX for these yet.
        break;
    }
  }

  // 5. Reconcile meshes with the interpolated world; get the local player's pos.
  const localFeet = syncEntities(entities, now);

  // 6. Advance transient combat VFX and the turn feed, culling the expired.
  updateEffects(dtMs);
  updateFeed(dtMs);

  // 7. Drive the third-person camera when we have a local body and the town.
  if (localFeet !== null && world !== null) {
    follow.update(localFeet, controls.yaw, world, dt);
  }

  // 8. Refresh the round HUD from the latest ROUND + connection/local state.
  //    On every transition BACK into the lobby, clear our local ready flag to
  //    match the server (which drops all readiness on a round reset), so the
  //    HUD never shows "ready" carried over from the previous match.
  const round = connection.round;
  const phase = round?.phase ?? null;
  if (phase === 'lobby' && lastPhase !== 'lobby') localReady = false;
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
      ? 'mouse: look (Esc releases)'
      : 'click canvas to look',
  });

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);

// Clean teardown on navigation so timers/sockets don't leak.
window.addEventListener('beforeunload', () => {
  connection.close();
  controls.dispose();
  hud.dispose();
});
