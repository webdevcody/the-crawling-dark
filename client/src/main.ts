/**
 * The Crawling Dark — client entry point (M2 · Movement & World demo).
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
 * There is no client-side prediction yet — the local player is also drawn from
 * interpolated server state, so it lags input slightly. Prediction/reconciliation
 * is M6 (t6a); until then this is the interpolation-only MVP the design calls for.
 */

import * as THREE from 'three';
import {
  MAP_SIZE,
  PLAYER_RADIUS,
  PLAYER_HEIGHT,
  CRAWL_HEIGHT,
  generateWorld,
  type World,
} from '@crawling-dark/shared';
import { Connection } from './net/Connection';
import { Controls } from './input/Controls';
import { FollowCamera } from './scene/FollowCamera';
import { buildTown } from './scene/TownView';

const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;

/* -------------------------------------------------------------------------- */
/* Renderer                                                                   */
/* -------------------------------------------------------------------------- */

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
app.appendChild(renderer.domElement);

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

const scene = new THREE.Scene();
const DARK = new THREE.Color(0x05070a);
scene.background = DARK;
// Linear fog so distant geometry dissolves into the crawling dark.
scene.fog = new THREE.Fog(DARK, MAP_SIZE * 0.12, MAP_SIZE * 0.9);

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
/* Lighting                                                                   */
/* -------------------------------------------------------------------------- */

const ambient = new THREE.AmbientLight(0x2a3846, 0.5);
scene.add(ambient);

const moon = new THREE.DirectionalLight(0xa9c7ff, 1.0);
moon.position.set(MAP_SIZE * 0.3, MAP_SIZE * 0.6, MAP_SIZE * 0.2);
moon.target.position.set(0, 0, 0);
scene.add(moon);
scene.add(moon.target);

/* -------------------------------------------------------------------------- */
/* Networking + input                                                         */
/* -------------------------------------------------------------------------- */

const connection = new Connection();
const controls = new Controls();
controls.attachPointerLock(renderer.domElement);
connection.connect();

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
}

/* -------------------------------------------------------------------------- */
/* Entity meshes — reconciled against interpolated snapshots each frame        */
/* -------------------------------------------------------------------------- */

/** Unit-height player box (footprint = collision diameter); scaled per-frame by profile. */
const PLAYER_GEOMETRY = new THREE.BoxGeometry(
  PLAYER_RADIUS * 2,
  1,
  PLAYER_RADIUS * 2,
);

/** Highlight color for the local player so you can tell which body is you. */
const LOCAL_COLOR = new THREE.Color(0x53ffa8);

/** Live meshes keyed by entity id, mirroring the interpolated entity set. */
const meshes = new Map<number, THREE.Mesh>();

/** Deterministic, well-spread color from an entity id (golden-ratio hue). */
function colorForId(id: number): THREE.Color {
  const hue = (id * 0.61803398875) % 1;
  return new THREE.Color().setHSL(hue, 0.6, 0.55);
}

/** Create (once) the mesh for an entity and add it to the scene. */
function createMesh(id: number, isLocal: boolean): THREE.Mesh {
  const color = isLocal ? LOCAL_COLOR.clone() : colorForId(id);
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.5,
    metalness: 0.1,
    emissive: isLocal ? LOCAL_COLOR.clone().multiplyScalar(0.25) : 0x000000,
  });
  const mesh = new THREE.Mesh(PLAYER_GEOMETRY, material);
  mesh.castShadow = true;
  scene.add(mesh);
  meshes.set(id, mesh);
  return mesh;
}

/**
 * Reconcile Three.js meshes with the interpolated entity set: spawn new bodies,
 * update transforms (height shrinks while crawling; `y` lifts on a jump), and
 * dispose meshes for entities that have left. Returns the local player's feet
 * position for the follow camera, or `null` if the local entity isn't present.
 */
function syncEntities(): { x: number; y: number; z: number } | null {
  const entities = connection.sampleEntities();
  const localId = connection.playerId;
  let localFeet: { x: number; y: number; z: number } | null = null;

  for (const entity of entities.values()) {
    const isLocal = entity.id === localId;
    const mesh = meshes.get(entity.id) ?? createMesh(entity.id, isLocal);

    // Crawling presents a low profile; standing bodies are full height.
    const bodyHeight = entity.state === 'crawl' ? CRAWL_HEIGHT : PLAYER_HEIGHT;
    mesh.scale.set(1, bodyHeight, 1);
    // `entity.y` is the feet height (0 on the ground, >0 mid-jump); the box is
    // centered, so lift it by half its scaled height to rest the base there.
    mesh.position.set(entity.x, entity.y + bodyHeight / 2, entity.z);
    mesh.rotation.y = entity.yaw;

    if (isLocal) localFeet = { x: entity.x, y: entity.y, z: entity.z };
  }

  // Remove departed entities.
  for (const [id, mesh] of meshes) {
    if (!entities.has(id)) {
      scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      meshes.delete(id);
    }
  }

  return localFeet;
}

/* -------------------------------------------------------------------------- */
/* HUD overlay                                                                */
/* -------------------------------------------------------------------------- */

const hud = document.createElement('div');
Object.assign(hud.style, {
  position: 'fixed',
  top: '12px',
  left: '12px',
  padding: '10px 14px',
  font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#c8d6e5',
  background: 'rgba(5, 7, 10, 0.72)',
  border: '1px solid rgba(58, 90, 106, 0.5)',
  borderRadius: '6px',
  pointerEvents: 'none',
  userSelect: 'none',
  whiteSpace: 'pre',
  backdropFilter: 'blur(2px)',
} satisfies Partial<CSSStyleDeclaration>);
app.appendChild(hud);

/** Color-tagged status dot for the HUD. */
function statusColor(status: string): string {
  switch (status) {
    case 'open':
      return '#53ffa8';
    case 'connecting':
    case 'reconnecting':
      return '#ffd24a';
    default:
      return '#ff6b6b';
  }
}

function updateHud(): void {
  const status = connection.status;
  const lookHint = controls.pointerLocked
    ? 'mouse: look (Esc releases)'
    : 'click canvas to look';
  hud.innerHTML =
    `<span style="color:${statusColor(status)}">●</span> ` +
    `<b>The Crawling Dark</b> · M2\n` +
    `status    ${status}\n` +
    `playerId  ${connection.playerId ?? '—'}\n` +
    `entities  ${connection.entityCount}\n` +
    `tick      ${connection.tick}\n` +
    `rtt       ${connection.rttMs > 0 ? `${Math.round(connection.rttMs)} ms` : '—'}\n` +
    `move      WASD · Shift run · C crawl${controls.crawling ? ' [on]' : ''} · Space jump\n` +
    `${lookHint}`;
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

  // 1. Push this frame's input (held-key bitmask + look yaw) to the server.
  connection.sendInput(controls.keys, dt, controls.yaw);

  // 2. Build the town once we know the seed.
  ensureWorld();

  // 3. Reconcile meshes with the interpolated world; get the local player's pos.
  const localFeet = syncEntities();

  // 4. Drive the third-person camera when we have a local body and the town.
  if (localFeet !== null && world !== null) {
    follow.update(localFeet, controls.yaw, world, dt);
  }

  // 5. Refresh the HUD.
  updateHud();

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);

// Clean teardown on navigation so timers/sockets don't leak.
window.addEventListener('beforeunload', () => {
  connection.close();
  controls.dispose();
});
