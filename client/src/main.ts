import * as THREE from 'three';
import { MAP_SIZE, ROUND_LENGTH_SEC } from '@crawling-dark/shared';

// Prove the shared workspace import is wired up end-to-end.
console.log('[client] round length (s):', ROUND_LENGTH_SEC, 'map size:', MAP_SIZE);

const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;

// --- Renderer -------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
app.appendChild(renderer.domElement);

// --- Scene ----------------------------------------------------------------
const scene = new THREE.Scene();
const DARK = new THREE.Color(0x05070a);
scene.background = DARK;
// Linear fog so distant ground dissolves into the crawling dark.
scene.fog = new THREE.Fog(DARK, MAP_SIZE * 0.12, MAP_SIZE * 0.85);

// --- Camera ---------------------------------------------------------------
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
const CAMERA_RADIUS = MAP_SIZE * 0.35;
const CAMERA_HEIGHT = MAP_SIZE * 0.25;
camera.position.set(0, CAMERA_HEIGHT, CAMERA_RADIUS);
camera.lookAt(0, 0, 0);

// --- Ground plane ---------------------------------------------------------
// MAP_SIZE from @crawling-dark/shared drives the world geometry.
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

// A subtle marker at the origin so the scene is visibly alive.
const markerGeometry = new THREE.BoxGeometry(2, 2, 2);
const markerMaterial = new THREE.MeshStandardMaterial({
  color: 0x3a5a6a,
  roughness: 0.6,
  metalness: 0.1,
});
const marker = new THREE.Mesh(markerGeometry, markerMaterial);
marker.position.set(0, 1, 0);
scene.add(marker);

// --- Lighting -------------------------------------------------------------
const ambient = new THREE.AmbientLight(0x22303c, 0.4);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xa9c7ff, 1.1);
sun.position.set(MAP_SIZE * 0.3, MAP_SIZE * 0.6, MAP_SIZE * 0.2);
sun.target.position.set(0, 0, 0);
scene.add(sun);
scene.add(sun.target);

// --- Resize handling ------------------------------------------------------
function onResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

// --- Render loop ----------------------------------------------------------
const clock = new THREE.Clock();

function animate(): void {
  const elapsed = clock.getElapsedTime();

  // Slow orbit so the lit plane reads as a live 3D scene.
  const angle = elapsed * 0.15;
  camera.position.set(
    Math.sin(angle) * CAMERA_RADIUS,
    CAMERA_HEIGHT,
    Math.cos(angle) * CAMERA_RADIUS,
  );
  camera.lookAt(0, 0, 0);

  marker.rotation.y = elapsed * 0.6;

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);
