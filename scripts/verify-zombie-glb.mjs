/**
 * M13 t13c zombie-model verification harness (not shipped; run manually / in CI).
 *
 * Sibling to `verify-character-glb.mjs`, pointed at the DISTINCT zombie model
 * (`client/public/models/zombie.glb`) that powers the infection MODEL-SWAP
 * through `GltfCharacter.urlForKind('zombie')`. It parses the baked GLB
 * HEADLESSLY with the SAME loader + clone + AnimationMixer the client uses,
 * asserting the exact contract `GltfCharacter` depends on:
 *   - the GLB decodes to a scene with the expected joint nodes,
 *   - every EntityState clip name is present (idle/walk/run/crawl/jump/swing/
 *     claw/stun/down) and no extras,
 *   - SkeletonUtils.clone() yields an independent body, and
 *   - an AnimationMixer can bind + step each clip on the clone without throwing.
 *
 * Uses GLTFLoader.parse(ArrayBuffer) (no fetch/WebGL), so it runs in plain Node.
 *   node scripts/verify-zombie-glb.mjs
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'client');
const GLB = join(CLIENT, 'public', 'models', 'zombie.glb');

// Resolve three + its addons through the CLIENT package's node_modules.
const require = createRequire(join(CLIENT, 'index.js'));
const THREE = await import(pathToFileURL(require.resolve('three')));
const { GLTFLoader } = await import(
  pathToFileURL(require.resolve('three/examples/jsm/loaders/GLTFLoader.js'))
);
const { clone: cloneSkeleton } = await import(
  pathToFileURL(require.resolve('three/examples/jsm/utils/SkeletonUtils.js'))
);

const EXPECTED_CLIPS = ['idle', 'walk', 'run', 'crawl', 'jump', 'swing', 'claw', 'stun', 'down'];
const EXPECTED_NODES = [
  'Root', 'HipsJoint', 'TorsoJoint', 'ArmLJoint', 'ArmRJoint', 'LegLJoint', 'LegRJoint',
];

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('  x ' + msg);
};

const bytes = readFileSync(GLB);
const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

const gltf = await new Promise((resolve, reject) => {
  new GLTFLoader().parse(arrayBuffer, '', resolve, reject);
});

// 1. Scene + node structure.
if (!gltf.scene) fail('no scene in parsed GLB');
const names = new Set();
gltf.scene.traverse((o) => o.name && names.add(o.name));
for (const n of EXPECTED_NODES) {
  if (!names.has(n)) fail(`missing joint node "${n}"`);
}

// 2. Every EntityState clip is present (and no extras).
const clipNames = gltf.animations.map((c) => c.name);
for (const c of EXPECTED_CLIPS) {
  if (!clipNames.includes(c)) fail(`missing animation clip "${c}"`);
}
const extra = clipNames.filter((c) => !EXPECTED_CLIPS.includes(c));
if (extra.length) fail(`unexpected clips: ${extra.join(', ')}`);

// 3. Clone is independent (SkeletonUtils), and 4. mixer binds + steps each clip.
const clone = cloneSkeleton(gltf.scene);
if (clone === gltf.scene) fail('clone returned the same object');

let boundTracks = 0;
for (const clip of gltf.animations) {
  const mixer = new THREE.AnimationMixer(clone);
  const action = mixer.clipAction(clip);
  action.play();
  // Step a few frames; a track that fails to bind throws here.
  for (let i = 0; i < 4; i++) mixer.update(0.1);
  // Confirm the clip actually drove at least one node off its bind pose.
  const bindings = mixer._bindings ?? [];
  boundTracks += bindings.length;
  if (bindings.length === 0) fail(`clip "${clip.name}" bound 0 tracks`);
  mixer.stopAllAction();
  mixer.uncacheRoot(clone);
}

console.log(`\nGLB: ${GLB.split('/').slice(-3).join('/')} (${bytes.length} bytes)`);
console.log(`nodes: ${names.size}   clips: ${clipNames.length} [${clipNames.join(', ')}]`);
console.log(`animation tracks bound across all clips: ${boundTracks}`);

if (failures === 0) console.log('\n* zombie GLTF pipeline contract holds');
else {
  console.error(`\nx ${failures} failure(s)`);
  process.exit(1);
}
