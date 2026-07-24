/**
 * The Crawling Dark — placeholder CC0 rigged-character generator (M13 · t13a).
 *
 * This sandbox ships with no authored 3D art and has no reliable runtime fetch,
 * yet t13a's GLTF pipeline (`client/src/entities/GltfCharacter.ts`) needs a
 * *real* `.glb` to exercise its load -> clone -> AnimationMixer path. Rather than
 * pull a binary off the network, we BAKE a tiny box-man here — procedural,
 * offline, and CC0 by construction (authored entirely by this script).
 *
 * The model is a jointed humanoid of unit-cube parts (torso + head + two arms +
 * two legs on hip/shoulder pivots) sized to the same proportions as the
 * procedural rig in `entities/Character.ts`, plus one animation clip PER ENTITY
 * STATE, each named exactly as `GltfCharacter` looks them up:
 *
 *   idle . walk . run . crawl . jump . swing . claw . stun . down
 *
 * (`swing` = a human's bat attack, `claw` = a zombie's — the two faces of the
 * shared `attack` state.) Every clip loops, so the mixer can cross-fade between
 * them exactly as a real rigged export would. Drop a real `.glb` with the same
 * clip names over this file to upgrade with zero code changes — see
 * `client/public/models/ATTRIBUTION.md`.
 *
 * Run with `node scripts/gen-character-glb.mjs`; it (re)writes
 * `client/public/models/character.glb`. Output is deterministic/byte-stable.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'client', 'public', 'models');
const OUT_FILE = join(OUT_DIR, 'character.glb');

/* -------------------------------------------------------------------------- */
/* glTF constants                                                              */
/* -------------------------------------------------------------------------- */

const FLOAT = 5126;
const USHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/* -------------------------------------------------------------------------- */
/* Binary accessor packing                                                     */
/* -------------------------------------------------------------------------- */

const binChunks = [];
let binLen = 0;
const bufferViews = [];
const accessors = [];

/** 4-byte-align the running BIN length (covers both float and ushort views). */
function align4() {
  const pad = (4 - (binLen % 4)) % 4;
  if (pad > 0) {
    binChunks.push(Buffer.alloc(pad));
    binLen += pad;
  }
}

/**
 * Append a typed array to the BIN blob as a bufferView + accessor and return the
 * accessor index. `min`/`max` are required by glTF for POSITION and for every
 * animation-sampler INPUT (time) accessor.
 */
function addAccessor(typed, componentType, type, { target, min, max } = {}) {
  align4();
  const bytes = Buffer.from(
    typed.buffer.slice(typed.byteOffset, typed.byteOffset + typed.byteLength),
  );
  const bvIndex = bufferViews.length;
  bufferViews.push({
    buffer: 0,
    byteOffset: binLen,
    byteLength: bytes.length,
    ...(target ? { target } : {}),
  });
  binChunks.push(bytes);
  binLen += bytes.length;

  const accIndex = accessors.length;
  const acc = {
    bufferView: bvIndex,
    byteOffset: 0,
    componentType,
    count: typed.length / COMPONENTS[type],
    type,
  };
  if (min) acc.min = min;
  if (max) acc.max = max;
  accessors.push(acc);
  return accIndex;
}

/* -------------------------------------------------------------------------- */
/* Geometry — one shared unit cube (centered at origin, 1x1x1)                  */
/* -------------------------------------------------------------------------- */

function unitCube() {
  const faces = [
    { n: [0, 0, 1], v: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { n: [0, 0, -1], v: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
    { n: [1, 0, 0], v: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
    { n: [-1, 0, 0], v: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
    { n: [0, 1, 0], v: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { n: [0, -1, 0], v: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  ];
  const pos = [];
  const nor = [];
  const idx = [];
  faces.forEach((f, fi) => {
    for (const p of f.v) {
      pos.push(...p);
      nor.push(...f.n);
    }
    const b = fi * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return {
    pos: new Float32Array(pos),
    nor: new Float32Array(nor),
    idx: new Uint16Array(idx),
  };
}

const cube = unitCube();
const posAcc = addAccessor(cube.pos, FLOAT, 'VEC3', {
  target: ARRAY_BUFFER,
  min: [-0.5, -0.5, -0.5],
  max: [0.5, 0.5, 0.5],
});
const norAcc = addAccessor(cube.nor, FLOAT, 'VEC3', { target: ARRAY_BUFFER });
const idxAcc = addAccessor(cube.idx, USHORT, 'SCALAR', { target: ELEMENT_ARRAY_BUFFER });

const meshes = [
  {
    name: 'BodyPart',
    primitives: [
      { attributes: { POSITION: posAcc, NORMAL: norAcc }, indices: idxAcc, material: 0 },
    ],
  },
];

const materials = [
  {
    name: 'CharacterMat',
    pbrMetallicRoughness: {
      baseColorFactor: [0.82, 0.82, 0.85, 1],
      metallicFactor: 0.1,
      roughnessFactor: 0.6,
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Node hierarchy — joints (animated pivots) + leaf meshes                      */
/* -------------------------------------------------------------------------- */
/*
 * Proportions mirror `entities/Character.ts` (HIP_Y 0.92, torso 0.46x0.62x0.28,
 * arms 0.62, legs 0.92), feet at y=0. JOINT nodes carry no scale/mesh so their
 * rotation is a clean swing pivot; each LEAF holds the box scale + a translation
 * that places the part below/around its pivot (matching the procedural rig).
 */
const nodes = [];
const nodeIndex = {};

function node(name, { t = [0, 0, 0], s, mesh, children } = {}) {
  const n = { name, translation: t };
  if (s) n.scale = s;
  if (mesh !== undefined) n.mesh = mesh;
  if (children) n.children = children;
  const i = nodes.length;
  nodes.push(n);
  nodeIndex[name] = i;
  return i;
}

// Leaves first (so parents can list their indices). Each references mesh 0.
const torsoMesh = node('TorsoMesh', { t: [0, 0.31, 0], s: [0.46, 0.62, 0.28], mesh: 0 });
const headMesh = node('HeadMesh', { t: [0, 0.84, 0], s: [0.32, 0.32, 0.32], mesh: 0 });
const armLMesh = node('ArmLMesh', { t: [0, -0.31, 0], s: [0.14, 0.62, 0.14], mesh: 0 });
const armRMesh = node('ArmRMesh', { t: [0, -0.31, 0], s: [0.14, 0.62, 0.14], mesh: 0 });
const legLMesh = node('LegLMesh', { t: [0, -0.46, 0], s: [0.17, 0.92, 0.17], mesh: 0 });
const legRMesh = node('LegRMesh', { t: [0, -0.46, 0], s: [0.17, 0.92, 0.17], mesh: 0 });

// Shoulder / hip joints (pivots), each carrying one limb leaf.
const armLJoint = node('ArmLJoint', { t: [-0.3, 0.62, 0], children: [armLMesh] });
const armRJoint = node('ArmRJoint', { t: [0.3, 0.62, 0], children: [armRMesh] });
const legLJoint = node('LegLJoint', { t: [-0.13, 0, 0], children: [legLMesh] });
const legRJoint = node('LegRJoint', { t: [0.13, 0, 0], children: [legRMesh] });

// Torso lean pivot carries the upper body; hips carry torso + legs; root at feet.
const torsoJoint = node('TorsoJoint', { children: [torsoMesh, headMesh, armLJoint, armRJoint] });
const hipsJoint = node('HipsJoint', { t: [0, 0.92, 0], children: [torsoJoint, legLJoint, legRJoint] });
const rootNode = node('Root', { children: [hipsJoint] });

/* -------------------------------------------------------------------------- */
/* Animation clips — one per EntityState, all looping                          */
/* -------------------------------------------------------------------------- */

/** Unit-axis quaternion for a rotation of `angle` rad about `axis`. */
function quat(axis, angle) {
  const h = angle / 2;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}
const X = [1, 0, 0];
const Z = [0, 0, 1];

const animations = [];

/**
 * Build one named clip from a list of channels. Each channel rotates a joint
 * through `keys` = [[t, axis, angle], ...]; times drive a LINEAR sampler. First
 * and last key should match so the clip loops seamlessly.
 */
function clip(name, channels) {
  const samplers = [];
  const chans = [];
  for (const ch of channels) {
    const times = new Float32Array(ch.keys.map((k) => k[0]));
    const quats = new Float32Array(ch.keys.flatMap((k) => quat(k[1], k[2])));
    const input = addAccessor(times, FLOAT, 'SCALAR', {
      min: [times[0]],
      max: [times[times.length - 1]],
    });
    const output = addAccessor(quats, FLOAT, 'VEC4');
    const si = samplers.length;
    samplers.push({ input, output, interpolation: 'LINEAR' });
    chans.push({ sampler: si, target: { node: nodeIndex[ch.joint], path: 'rotation' } });
  }
  animations.push({ name, samplers, channels: chans });
}

// A limb "swing" is rotation about X (a downward limb's tip rakes toward -Z for
// a positive angle — same convention as the procedural rig). Stride loops use 5
// keys (0->+A->0->-A->0); static poses use 2 equal keys the mixer simply holds.
const swingLR = (joint, amp, dur, phase = 1) => ({
  joint,
  keys: [
    [0, X, 0],
    [dur * 0.25, X, amp * phase],
    [dur * 0.5, X, 0],
    [dur * 0.75, X, -amp * phase],
    [dur, X, 0],
  ],
});
const hold = (joint, axis, angle, dur = 1) => ({
  joint,
  keys: [
    [0, axis, angle],
    [dur, axis, angle],
  ],
});

clip('idle', [
  { joint: 'ArmLJoint', keys: [[0, X, 0.05], [1, X, -0.05], [2, X, 0.05]] },
  { joint: 'ArmRJoint', keys: [[0, X, -0.05], [1, X, 0.05], [2, X, -0.05]] },
]);

clip('walk', [
  swingLR('LegLJoint', 0.5, 1),
  swingLR('LegRJoint', 0.5, 1, -1),
  swingLR('ArmLJoint', 0.45, 1, -1),
  swingLR('ArmRJoint', 0.45, 1),
]);

clip('run', [
  swingLR('LegLJoint', 0.85, 0.7),
  swingLR('LegRJoint', 0.85, 0.7, -1),
  swingLR('ArmLJoint', 0.8, 0.7, -1),
  swingLR('ArmRJoint', 0.8, 0.7),
  hold('TorsoJoint', X, -0.28, 0.7),
]);

clip('crawl', [
  hold('HipsJoint', X, -1.15),
  hold('TorsoJoint', X, 0.35),
  swingLR('LegLJoint', 0.3, 1.4),
  swingLR('LegRJoint', 0.3, 1.4, -1),
]);

clip('jump', [
  hold('LegLJoint', X, 0.9),
  hold('LegRJoint', X, 0.85),
  hold('ArmLJoint', X, 1.5),
  hold('ArmRJoint', X, 1.5),
]);

clip('swing', [
  { joint: 'ArmRJoint', keys: [[0, X, 2.6], [0.5, X, 0.2], [1, X, 2.6]] },
  hold('ArmLJoint', X, 0.4),
  hold('TorsoJoint', X, -0.2),
]);

clip('claw', [
  { joint: 'ArmLJoint', keys: [[0, X, 1.3], [0.5, X, 1.9], [1, X, 1.3]] },
  { joint: 'ArmRJoint', keys: [[0, X, 1.9], [0.5, X, 1.3], [1, X, 1.9]] },
  hold('TorsoJoint', X, -0.3),
]);

clip('stun', [
  { joint: 'Root', keys: [[0, Z, 0.14], [0.5, Z, -0.14], [1, Z, 0.14]] },
  { joint: 'ArmLJoint', keys: [[0, X, 0.3], [0.5, X, -0.3], [1, X, 0.3]] },
  { joint: 'ArmRJoint', keys: [[0, X, -0.3], [0.5, X, 0.3], [1, X, -0.3]] },
]);

clip('down', [
  hold('HipsJoint', X, -1.45),
  hold('ArmLJoint', Z, -0.2),
  hold('ArmRJoint', Z, 0.2),
]);

/* -------------------------------------------------------------------------- */
/* Assemble + write the GLB                                                     */
/* -------------------------------------------------------------------------- */

const gltf = {
  asset: { version: '2.0', generator: 'the-crawling-dark gen-character-glb.mjs (CC0)' },
  scene: 0,
  scenes: [{ nodes: [rootNode] }],
  nodes,
  meshes,
  materials,
  accessors,
  bufferViews,
  buffers: [{ byteLength: binLen }],
  animations,
};

const bin = Buffer.concat(binChunks);
const json = Buffer.from(JSON.stringify(gltf), 'utf8');

/** Pad a chunk body to a 4-byte boundary with `padByte`. */
function pad4(buf, padByte) {
  const pad = (4 - (buf.length % 4)) % 4;
  return pad === 0 ? buf : Buffer.concat([buf, Buffer.alloc(pad, padByte)]);
}

const jsonChunk = pad4(json, 0x20); // spaces
const binChunk = pad4(bin, 0x00); // zeros
const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;

const out = Buffer.alloc(total);
let o = 0;
out.writeUInt32LE(0x46546c67, o); o += 4; // "glTF"
out.writeUInt32LE(2, o); o += 4; // version
out.writeUInt32LE(total, o); o += 4; // total length
out.writeUInt32LE(jsonChunk.length, o); o += 4;
out.writeUInt32LE(0x4e4f534a, o); o += 4; // "JSON"
jsonChunk.copy(out, o); o += jsonChunk.length;
out.writeUInt32LE(binChunk.length, o); o += 4;
out.writeUInt32LE(0x004e4942, o); o += 4; // "BIN\0"
binChunk.copy(out, o); o += binChunk.length;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, out);
// eslint-disable-next-line no-console
console.log(
  `wrote ${OUT_FILE} (${out.length} bytes) — ${nodes.length} nodes, ${animations.length} clips: ${animations
    .map((a) => a.name)
    .join(', ')}`,
);
