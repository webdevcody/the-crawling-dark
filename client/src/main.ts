/**
 * The Crawling Dark — client entry point (M1 · t1e demo).
 *
 * Wires the networking spine (`Connection`) and keyboard sampler (`Controls`)
 * into a minimal Three.js scene: a dark, fogged play area viewed from a fixed
 * slightly-angled overhead camera. Each authoritative entity is drawn as a
 * unit box resting on the ground; the local player (matching WELCOME.playerId)
 * is highlighted. A dark-themed HUD reports connection status, playerId,
 * entity count, server tick, and smoothed RTT.
 *
 * Collision, a spring-arm/third-person follow camera, and entity interpolation
 * are intentionally out of scope for M1 (they land in M2/M6).
 */

import * as THREE from 'three';
import {
  MAP_SIZE,
  type EntitySnapshot,
} from '@crawling-dark/shared';
import { Connection } from './net/Connection';
import { Controls } from './input/Controls';

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
// Linear fog so distant ground dissolves into the crawling dark.
scene.fog = new THREE.Fog(DARK, MAP_SIZE * 0.12, MAP_SIZE * 0.85);

/* -------------------------------------------------------------------------- */
/* Camera — fixed, gently-angled overhead view of the play area              */
/* -------------------------------------------------------------------------- */

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
// A stable 3rd-person-ish angle looking at the origin: high enough to read
// box movement across the XZ plane, close enough that boxes stay legible.
camera.position.set(0, MAP_SIZE * 0.2, MAP_SIZE * 0.26);
camera.lookAt(0, 0, 0);

/* -------------------------------------------------------------------------- */
/* Ground plane                                                               */
/* -------------------------------------------------------------------------- */

const groundGeometry = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE);
groundGeometry.rotateX(-Math.PI / 2);
const groundMaterial = new THREE.MeshStandardMaterial({
  color: 0x1a2430,
  roughness: 1,
  metalness: 0,
});
const ground = new THREE.Mesh(groundGeometry, groundMaterial);
ground.receiveShadow = true;
scene.add(ground);

// A faint grid overlay so movement across the plane has a spatial reference.
const grid = new THREE.GridHelper(MAP_SIZE, MAP_SIZE / 4, 0x2a3a48, 0x141d26);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.35;
grid.position.y = 0.01;
scene.add(grid);

/* -------------------------------------------------------------------------- */
/* Lighting                                                                   */
/* -------------------------------------------------------------------------- */

const ambient = new THREE.AmbientLight(0x22303c, 0.4);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xa9c7ff, 1.1);
sun.position.set(MAP_SIZE * 0.3, MAP_SIZE * 0.6, MAP_SIZE * 0.2);
sun.target.position.set(0, 0, 0);
scene.add(sun);
scene.add(sun.target);

/* -------------------------------------------------------------------------- */
/* Networking + input                                                         */
/* -------------------------------------------------------------------------- */

const connection = new Connection();
const controls = new Controls();
connection.connect();

/* -------------------------------------------------------------------------- */
/* Entity meshes — reconciled against the connection's entity store each frame */
/* -------------------------------------------------------------------------- */

/** Unit cube shared by every entity mesh; per-entity color lives in materials. */
const BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);

/** Highlight color for the local player so you can tell which box is you. */
const LOCAL_COLOR = new THREE.Color(0x53ffa8);

/** Live meshes keyed by entity id, mirroring the authoritative store. */
const meshes = new Map<number, THREE.Mesh>();

/** Deterministic, well-spread color from an entity id (golden-ratio hue). */
function colorForId(id: number): THREE.Color {
  const hue = (id * 0.61803398875) % 1;
  return new THREE.Color().setHSL(hue, 0.65, 0.55);
}

/** Create (once) the mesh for an entity and add it to the scene. */
function createMesh(entity: EntitySnapshot, isLocal: boolean): THREE.Mesh {
  const color = isLocal ? LOCAL_COLOR.clone() : colorForId(entity.id);
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.5,
    metalness: 0.1,
    // Local player glows faintly so it reads even in shadow.
    emissive: isLocal ? LOCAL_COLOR.clone().multiplyScalar(0.25) : 0x000000,
  });
  const mesh = new THREE.Mesh(BOX_GEOMETRY, material);
  scene.add(mesh);
  meshes.set(entity.id, mesh);
  return mesh;
}

/**
 * Reconcile the Three.js meshes with the authoritative entity store: spawn new
 * boxes, update positions/facing, and dispose meshes for departed entities.
 */
function syncEntities(): void {
  const store = connection.entities;
  const localId = connection.playerId;

  // Create / update.
  for (const entity of store.values()) {
    const isLocal = entity.id === localId;
    const mesh = meshes.get(entity.id) ?? createMesh(entity, isLocal);
    // Box is 1 unit tall; lift by 0.5 so its base rests on the ground plane.
    mesh.position.set(entity.x, entity.y + 0.5, entity.z);
    mesh.rotation.y = entity.yaw;
  }

  // Remove departed entities.
  for (const [id, mesh] of meshes) {
    if (!store.has(id)) {
      scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      meshes.delete(id);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* HUD overlay (dark theme, consistent with index.html)                       */
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

/** Human-friendly, color-tagged status dot for the HUD. */
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
  const playerId = connection.playerId;
  hud.innerHTML =
    `<span style="color:${statusColor(status)}">●</span> ` +
    `<b>The Crawling Dark</b> · M1\n` +
    `status    ${status}\n` +
    `playerId  ${playerId ?? '—'}\n` +
    `entities  ${connection.entityCount}\n` +
    `tick      ${connection.tick}\n` +
    `rtt       ${connection.rttMs > 0 ? `${Math.round(connection.rttMs)} ms` : '—'}`;
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

  // 1. Push this frame's held-key sample to the server (yaw fixed to 0 in M1).
  connection.sendInput(controls.keys, dt);

  // 2. Reconcile the scene with the latest authoritative snapshot.
  syncEntities();

  // 3. Refresh the on-screen HUD.
  updateHud();

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);

// Clean teardown on navigation so timers/sockets don't leak.
window.addEventListener('beforeunload', () => {
  connection.close();
  controls.dispose();
});
