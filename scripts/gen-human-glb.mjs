/**
 * The Crawling Dark — baked CC0 rigged HUMAN model (M13 · t13b).
 *
 * An UPGRADE over the box-man placeholder (`gen-character-glb.mjs`): still a
 * hand-written binary glTF (no npm deps, no `three` at author time, fully
 * offline and byte-deterministic), but now it reads clearly as an upright
 * person. Round primitives replace unit cubes — a UV-sphere head, tapered
 * cylinders for a proper torso/neck/arms/legs (all with CORRECT per-vertex
 * normals, incl. the cone slope so lighting reads) — plus distinguishing detail
 * parts: blocky hands, forward-toed shoes, and the human's signature **baseball
 * bat** held in the right hand (a thin->fat tapered cylinder parented under
 * `ArmRJoint`, so it swings with the arm).
 *
 * It is consumed through the very same seam as the box-man — `GltfCharacter`
 * clones the scene per body, tints EVERY material to the team color, and
 * cross-fades to the clip whose name matches the entity state:
 *
 *   idle . walk . run . crawl . jump . swing . claw . stun . down
 *
 * (`swing` is the human's bat attack; `claw` exists for contract completeness —
 * a light two-handed rake.) Every clip loops (first key == last key). All mesh
 * primitives share material 0 because the runtime flattens every material to one
 * team color anyway.
 *
 * Orientation: Y-up, feet at the origin (y=0), ~1.8 m tall, facing -Z, HipsJoint
 * at y=0.92 — the same rig contract the procedural `Character` and the box-man
 * export use, so it is a drop-in with zero code changes.
 *
 * Run with `node scripts/gen-human-glb.mjs`; it (re)writes
 * `client/public/models/human.glb`. Output is deterministic/byte-stable.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'client', 'public', 'models');
const OUT_FILE = join(OUT_DIR, 'human.glb');

/* -------------------------------------------------------------------------- */
/* glTF constants                                                              */
/* -------------------------------------------------------------------------- */

const FLOAT = 5126;
const USHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

const HIP_Y = 0.92; // pelvis pivot height (matches the procedural rig)

/* -------------------------------------------------------------------------- */
/* Binary accessor packing (identical scaffolding to gen-character-glb.mjs)     */
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
/* Vertex generators — box, tapered cylinder, UV sphere (correct normals)       */
/* -------------------------------------------------------------------------- */

function normalize3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Axis-aligned box centered at the origin; flat per-face normals. */
function box(w, h, d) {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  const faces = [
    { n: [0, 0, 1], v: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
    { n: [0, 0, -1], v: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
    { n: [1, 0, 0], v: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
    { n: [-1, 0, 0], v: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    { n: [0, 1, 0], v: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { n: [0, -1, 0], v: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
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
  return { pos, nor, idx };
}

/**
 * Vertical (tapered) cylinder centered at the origin, axis along +Y, spanning
 * -h/2..+h/2. Side normals include the cone slope so a tapered limb lights
 * correctly. Winding/normals mirror three.js CylinderGeometry.
 */
function cylinder(radiusTop, radiusBottom, height, radialSegments = 12) {
  const pos = [];
  const nor = [];
  const idx = [];
  const halfH = height / 2;
  const slope = (radiusBottom - radiusTop) / height;
  const grid = [];
  let v = 0;

  // Side wall (single height segment is plenty for straight-sided limbs).
  for (let y = 0; y <= 1; y++) {
    const row = [];
    const t = y; // 0 = top, 1 = bottom
    const radius = t * (radiusBottom - radiusTop) + radiusTop;
    for (let x = 0; x <= radialSegments; x++) {
      const theta = (x / radialSegments) * Math.PI * 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      pos.push(radius * sinT, -t * height + halfH, radius * cosT);
      const n = normalize3(sinT, slope, cosT);
      nor.push(n[0], n[1], n[2]);
      row.push(v++);
    }
    grid.push(row);
  }
  for (let x = 0; x < radialSegments; x++) {
    const a = grid[0][x];
    const b = grid[1][x];
    const c = grid[1][x + 1];
    const d = grid[0][x + 1];
    idx.push(a, b, d, b, c, d);
  }

  // Caps (fan around a center vertex).
  const cap = (top) => {
    const radius = top ? radiusTop : radiusBottom;
    if (radius <= 0) return;
    const sign = top ? 1 : -1;
    const centerStart = v;
    for (let x = 0; x < radialSegments; x++) {
      pos.push(0, halfH * sign, 0);
      nor.push(0, sign, 0);
      v++;
    }
    const ringStart = v;
    for (let x = 0; x <= radialSegments; x++) {
      const theta = (x / radialSegments) * Math.PI * 2;
      pos.push(radius * Math.sin(theta), halfH * sign, radius * Math.cos(theta));
      nor.push(0, sign, 0);
      v++;
    }
    for (let x = 0; x < radialSegments; x++) {
      const c = centerStart + x;
      const i = ringStart + x;
      if (top) idx.push(i, i + 1, c);
      else idx.push(i + 1, i, c);
    }
  };
  cap(true);
  cap(false);
  return { pos, nor, idx };
}

/** UV sphere centered at the origin; smooth outward normals (three.js layout). */
function uvSphere(radius, widthSegments = 16, heightSegments = 12) {
  const pos = [];
  const nor = [];
  const idx = [];
  const grid = [];
  let v = 0;
  for (let iy = 0; iy <= heightSegments; iy++) {
    const row = [];
    const vy = iy / heightSegments;
    for (let ix = 0; ix <= widthSegments; ix++) {
      const ux = ix / widthSegments;
      const x = -radius * Math.cos(ux * Math.PI * 2) * Math.sin(vy * Math.PI);
      const y = radius * Math.cos(vy * Math.PI);
      const z = radius * Math.sin(ux * Math.PI * 2) * Math.sin(vy * Math.PI);
      pos.push(x, y, z);
      const n = normalize3(x, y, z);
      nor.push(n[0], n[1], n[2]);
      row.push(v++);
    }
    grid.push(row);
  }
  for (let iy = 0; iy < heightSegments; iy++) {
    for (let ix = 0; ix < widthSegments; ix++) {
      const a = grid[iy][ix + 1];
      const b = grid[iy][ix];
      const c = grid[iy + 1][ix];
      const d = grid[iy + 1][ix + 1];
      if (iy !== 0) idx.push(a, b, d);
      if (iy !== heightSegments - 1) idx.push(b, c, d);
    }
  }
  return { pos, nor, idx };
}

/* -------------------------------------------------------------------------- */
/* Meshes — one shared material; each part is its own mesh (all reference mat 0) */
/* -------------------------------------------------------------------------- */

const meshes = [];

/** Pack a {pos,nor,idx} part into accessors + a mesh (material 0); return index. */
function addMesh(name, geo) {
  const pos = new Float32Array(geo.pos);
  const nor = new Float32Array(geo.nor);
  const idx = new Uint16Array(geo.idx);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const val = pos[i + k];
      if (val < min[k]) min[k] = val;
      if (val > max[k]) max[k] = val;
    }
  }
  const p = addAccessor(pos, FLOAT, 'VEC3', { target: ARRAY_BUFFER, min, max });
  const n = addAccessor(nor, FLOAT, 'VEC3', { target: ARRAY_BUFFER });
  const i = addAccessor(idx, USHORT, 'SCALAR', { target: ELEMENT_ARRAY_BUFFER });
  const mi = meshes.length;
  meshes.push({
    name,
    primitives: [{ attributes: { POSITION: p, NORMAL: n }, indices: i, material: 0 }],
  });
  return mi;
}

// Unique part geometries (symmetric L/R parts share one mesh, instanced twice).
const pelvisMesh = addMesh('Pelvis', cylinder(0.155, 0.16, 0.16, 14));
const torsoMesh = addMesh('Torso', cylinder(0.185, 0.15, 0.44, 16));
const neckMesh = addMesh('Neck', cylinder(0.05, 0.063, 0.11, 10));
const headMesh = addMesh('Head', uvSphere(0.135, 16, 12));
const noseMesh = addMesh('Nose', box(0.045, 0.05, 0.05));
const shoulderMesh = addMesh('Shoulder', uvSphere(0.075, 10, 8));
const armMesh = addMesh('Arm', cylinder(0.06, 0.045, 0.6, 10));
const handMesh = addMesh('Hand', box(0.09, 0.11, 0.075));
const legMesh = addMesh('Leg', cylinder(0.11, 0.06, 0.8, 12));
const footMesh = addMesh('Foot', box(0.13, 0.1, 0.26));
const batMesh = addMesh('Bat', cylinder(0.02, 0.05, 0.58, 10));

const materials = [
  {
    name: 'HumanMat',
    pbrMetallicRoughness: {
      baseColorFactor: [0.82, 0.82, 0.85, 1],
      metallicFactor: 0.1,
      roughnessFactor: 0.6,
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Rotation helpers (used by both static bat tilt and animation channels)       */
/* -------------------------------------------------------------------------- */

/** Unit-axis quaternion for a rotation of `angle` rad about `axis`. */
function quat(axis, angle) {
  const h = angle / 2;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}
const X = [1, 0, 0];
const Z = [0, 0, 1];

/* -------------------------------------------------------------------------- */
/* Node hierarchy — joints (animated pivots) + leaf meshes + bat                */
/* -------------------------------------------------------------------------- */
/*
 * JOINT nodes (Root, Hips, Torso, arms, legs) carry no scale/mesh so their rotation
 * is a clean swing pivot; each LEAF holds an offset (and optional flatten scale
 * so round primitives read as a broad torso / egg head) placing the part around
 * its pivot. Detail nodes (hands, shoulders, feet, bat) hang under the right
 * joint so they move with the animation.
 */
const nodes = [];
const nodeIndex = {};

function node(name, { t, r, s, mesh, children } = {}) {
  const n = { name };
  if (t) n.translation = t;
  if (r) n.rotation = r;
  if (s) n.scale = s;
  if (mesh !== undefined) n.mesh = mesh;
  if (children) n.children = children;
  const i = nodes.length;
  nodes.push(n);
  nodeIndex[name] = i;
  return i;
}

// --- Upper-body leaves (children of TorsoJoint) ---------------------------
const torsoMeshN = node('TorsoMesh', { t: [0, 0.3, 0], s: [1.2, 1, 0.72], mesh: torsoMesh });
const neckMeshN = node('NeckMesh', { t: [0, 0.58, 0], mesh: neckMesh });
const headMeshN = node('HeadMesh', { t: [0, 0.74, 0], s: [0.92, 1.05, 0.95], mesh: headMesh });
const noseMeshN = node('NoseMesh', { t: [0, 0.72, -0.135], mesh: noseMesh });

// --- Arm leaves ------------------------------------------------------------
const shoulderLMeshN = node('ShoulderLMesh', { t: [0, -0.02, 0], mesh: shoulderMesh });
const armLMeshN = node('ArmLMesh', { t: [0, -0.3, 0], mesh: armMesh });
const handLMeshN = node('HandLMesh', { t: [0, -0.64, 0], mesh: handMesh });

const shoulderRMeshN = node('ShoulderRMesh', { t: [0, -0.02, 0], mesh: shoulderMesh });
const armRMeshN = node('ArmRMesh', { t: [0, -0.3, 0], mesh: armMesh });
const handRMeshN = node('HandRMesh', { t: [0, -0.64, 0], mesh: handMesh });

// The signature baseball bat: gripped at the right hand, tilted down-forward.
const batMeshN = node('BatMesh', { t: [0, -0.3, 0], mesh: batMesh });
const batNode = node('Bat', { t: [0, -0.64, 0], r: quat(X, 0.6), children: [batMeshN] });

// --- Leg leaves ------------------------------------------------------------
const pelvisMeshN = node('PelvisMesh', { t: [0, 0.03, 0], s: [1.15, 1, 0.78], mesh: pelvisMesh });
const legLMeshN = node('LegLMesh', { t: [0, -0.4, 0], mesh: legMesh });
const footLMeshN = node('FootLMesh', { t: [0, -0.87, -0.06], mesh: footMesh });
const legRMeshN = node('LegRMesh', { t: [0, -0.4, 0], mesh: legMesh });
const footRMeshN = node('FootRMesh', { t: [0, -0.87, -0.06], mesh: footMesh });

// --- Joints (pivots) -------------------------------------------------------
const armLJoint = node('ArmLJoint', {
  t: [-0.2, 0.5, 0],
  children: [shoulderLMeshN, armLMeshN, handLMeshN],
});
const armRJoint = node('ArmRJoint', {
  t: [0.2, 0.5, 0],
  children: [shoulderRMeshN, armRMeshN, handRMeshN, batNode],
});
const torsoJoint = node('TorsoJoint', {
  children: [torsoMeshN, neckMeshN, headMeshN, noseMeshN, armLJoint, armRJoint],
});
const legLJoint = node('LegLJoint', { t: [-0.11, 0, 0], children: [legLMeshN, footLMeshN] });
const legRJoint = node('LegRJoint', { t: [0.11, 0, 0], children: [legRMeshN, footRMeshN] });
const hipsJoint = node('HipsJoint', {
  t: [0, HIP_Y, 0],
  children: [pelvisMeshN, torsoJoint, legLJoint, legRJoint],
});
const rootNode = node('Root', { children: [hipsJoint] });

/* -------------------------------------------------------------------------- */
/* Animation clips — one per EntityState, all looping                          */
/* -------------------------------------------------------------------------- */

const animations = [];

/**
 * Build one named looping clip. `channels` rotate joints via
 * keys = [[t, axis, angle], ...]; `transChannels` translate joints via
 * keys = [[t, [x,y,z]], ...] (used for body bob/bounce and low postures).
 *
 * To stop a stale posture bleeding across a cross-fade, every clip is
 * auto-filled with identity rotation holds for Root/Hips/Torso it doesn't
 * already drive, and a HipsJoint translation hold at the rest height if it
 * doesn't move the hips itself.
 */
function clip(name, channels, transChannels = []) {
  let dur = 0;
  for (const ch of channels) dur = Math.max(dur, ch.keys[ch.keys.length - 1][0]);
  for (const ch of transChannels) dur = Math.max(dur, ch.keys[ch.keys.length - 1][0]);
  if (dur <= 0) dur = 1;

  const rotChannels = channels.slice();
  const animatedRot = new Set(channels.map((c) => c.joint));
  for (const j of ['Root', 'HipsJoint', 'TorsoJoint']) {
    if (!animatedRot.has(j)) rotChannels.push({ joint: j, keys: [[0, X, 0], [dur, X, 0]] });
  }
  const trans = transChannels.slice();
  if (!new Set(transChannels.map((c) => c.joint)).has('HipsJoint')) {
    trans.push({ joint: 'HipsJoint', keys: [[0, [0, HIP_Y, 0]], [dur, [0, HIP_Y, 0]]] });
  }

  const samplers = [];
  const chans = [];
  for (const ch of rotChannels) {
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
  for (const ch of trans) {
    const times = new Float32Array(ch.keys.map((k) => k[0]));
    const vecs = new Float32Array(ch.keys.flatMap((k) => k[1]));
    const input = addAccessor(times, FLOAT, 'SCALAR', {
      min: [times[0]],
      max: [times[times.length - 1]],
    });
    const output = addAccessor(vecs, FLOAT, 'VEC3');
    const si = samplers.length;
    samplers.push({ input, output, interpolation: 'LINEAR' });
    chans.push({ sampler: si, target: { node: nodeIndex[ch.joint], path: 'translation' } });
  }
  animations.push({ name, samplers, channels: chans });
}

// A limb "swing" rotates about X (a downward limb's tip rakes toward -Z for a
// positive angle). Stride loops use 5 keys (0->+A->0->-A->0).
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
const hipY = (keys) => ({ joint: 'HipsJoint', keys }); // translation channel

// idle: subtle breathing lift + lazy weight shift of the arms.
clip(
  'idle',
  [
    { joint: 'ArmLJoint', keys: [[0, X, 0.06], [1.2, X, -0.04], [2.4, X, 0.06]] },
    { joint: 'ArmRJoint', keys: [[0, X, -0.04], [1.2, X, 0.06], [2.4, X, -0.04]] },
    { joint: 'TorsoJoint', keys: [[0, X, 0.02], [1.2, X, 0.05], [2.4, X, 0.02]] },
  ],
  [hipY([[0, [0, HIP_Y, 0]], [1.2, [0, HIP_Y + 0.008, 0]], [2.4, [0, HIP_Y, 0]]])],
);

// walk: alternating legs + counter-swinging arms, light double-bob per stride.
clip(
  'walk',
  [
    swingLR('LegLJoint', 0.5, 1),
    swingLR('LegRJoint', 0.5, 1, -1),
    swingLR('ArmLJoint', 0.45, 1, -1),
    swingLR('ArmRJoint', 0.45, 1),
  ],
  [
    hipY([
      [0, [0, HIP_Y, 0]],
      [0.25, [0, HIP_Y - 0.018, 0]],
      [0.5, [0, HIP_Y, 0]],
      [0.75, [0, HIP_Y - 0.018, 0]],
      [1, [0, HIP_Y, 0]],
    ]),
  ],
);

// run: longer/faster stride, forward torso lean, bigger vertical bounce.
clip(
  'run',
  [
    swingLR('LegLJoint', 0.85, 0.7),
    swingLR('LegRJoint', 0.85, 0.7, -1),
    swingLR('ArmLJoint', 0.8, 0.7, -1),
    swingLR('ArmRJoint', 0.8, 0.7),
    hold('TorsoJoint', X, -0.3, 0.7),
  ],
  [
    hipY([
      [0, [0, HIP_Y, 0]],
      [0.175, [0, HIP_Y + 0.05, 0]],
      [0.35, [0, HIP_Y, 0]],
      [0.525, [0, HIP_Y + 0.05, 0]],
      [0.7, [0, HIP_Y, 0]],
    ]),
  ],
);

// crawl: body pitched low over the hips, arms reaching forward, legs trailing.
clip(
  'crawl',
  [
    hold('HipsJoint', X, -1.2, 1.4),
    hold('TorsoJoint', X, 0.4, 1.4),
    { joint: 'ArmLJoint', keys: [[0, X, 1.35], [0.7, X, 1.7], [1.4, X, 1.35]] },
    { joint: 'ArmRJoint', keys: [[0, X, 1.7], [0.7, X, 1.35], [1.4, X, 1.7]] },
    swingLR('LegLJoint', 0.25, 1.4),
    swingLR('LegRJoint', 0.25, 1.4, -1),
  ],
  [hipY([[0, [0, 0.5, 0]], [1.4, [0, 0.5, 0]]])],
);

// jump: knees tucked up, arms thrown overhead, hips at apex.
clip(
  'jump',
  [
    hold('LegLJoint', X, 1.0, 0.8),
    hold('LegRJoint', X, 0.95, 0.8),
    hold('ArmLJoint', X, 2.8, 0.8),
    hold('ArmRJoint', X, 2.8, 0.8),
    hold('TorsoJoint', X, 0.2, 0.8),
  ],
  [hipY([[0, [0, HIP_Y + 0.06, 0]], [0.8, [0, HIP_Y + 0.06, 0]]])],
);

// swing: the bat chops from raised-back to down-front; torso lunges forward.
clip(
  'swing',
  [
    { joint: 'ArmRJoint', keys: [[0, X, 2.7], [0.5, X, 0.15], [1, X, 2.7]] },
    hold('ArmLJoint', X, 0.4),
    { joint: 'TorsoJoint', keys: [[0, X, -0.15], [0.5, X, 0.25], [1, X, -0.15]] },
  ],
  [hipY([[0, [0, HIP_Y, 0]], [0.5, [0, HIP_Y - 0.02, -0.06]], [1, [0, HIP_Y, 0]]])],
);

// claw: a lighter two-handed forward rake (contract completeness on the human).
clip('claw', [
  { joint: 'ArmLJoint', keys: [[0, X, 1.2], [0.5, X, 1.8], [1, X, 1.2]] },
  { joint: 'ArmRJoint', keys: [[0, X, 1.2], [0.5, X, 1.8], [1, X, 1.2]] },
  { joint: 'TorsoJoint', keys: [[0, X, -0.2], [0.5, X, 0.05], [1, X, -0.2]] },
]);

// stun: rattled side-to-side sway with flailing arms.
clip(
  'stun',
  [
    { joint: 'Root', keys: [[0, Z, 0.14], [0.5, Z, -0.14], [1, Z, 0.14]] },
    { joint: 'ArmLJoint', keys: [[0, X, 0.3], [0.5, X, -0.3], [1, X, 0.3]] },
    { joint: 'ArmRJoint', keys: [[0, X, -0.3], [0.5, X, 0.3], [1, X, -0.3]] },
  ],
  [hipY([[0, [0, HIP_Y, 0]], [0.5, [0, HIP_Y - 0.012, 0]], [1, [0, HIP_Y, 0]]])],
);

// down: collapsed folded flat near the ground, legs tucked, arms splayed.
clip(
  'down',
  [
    hold('HipsJoint', X, -1.3),
    hold('TorsoJoint', X, -0.15),
    hold('LegLJoint', X, 0.6),
    hold('LegRJoint', X, 0.6),
    hold('ArmLJoint', Z, -0.3),
    hold('ArmRJoint', Z, 0.3),
  ],
  [hipY([[0, [0, 0.45, 0]], [1, [0, 0.45, 0]]])],
);

/* -------------------------------------------------------------------------- */
/* Assemble + write the GLB (identical container assembly to gen-character)     */
/* -------------------------------------------------------------------------- */

const gltf = {
  asset: { version: '2.0', generator: 'the-crawling-dark gen-human-glb.mjs (CC0)' },
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
  `wrote ${OUT_FILE} (${out.length} bytes) — ${nodes.length} nodes, ${meshes.length} meshes, ${animations.length} clips: ${animations
    .map((a) => a.name)
    .join(', ')}`,
);
