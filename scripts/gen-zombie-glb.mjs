/**
 * The Crawling Dark — DISTINCT zombie rigged-character generator (M13 · t13c).
 *
 * Sibling to `gen-character-glb.mjs` (the human/box placeholder). This bakes a
 * SEPARATE `.glb` so that an infection visibly MODEL-SWAPS through the
 * `GltfCharacter.urlForKind('zombie')` seam — not just a recolor of the human.
 *
 * Same hand-rolled, npm-dep-free GLB pipeline as the human generator (accessor
 * packing, GLB container assembly, one looping animation clip PER ENTITY STATE),
 * but the model reads as a hunched, gaunt, shambling zombie:
 *
 *   • rounder authored geometry — a UV-sphere head + tapered-cylinder limbs and
 *     torso (with correctly computed normals), not six upright unit cubes;
 *   • a distinctive BASE-POSE silhouette baked into fixed intermediate nodes
 *     that the animated joints compose on top of: a forward-hunched spine, a
 *     lolling/tilted head, arms slung forward that are LONGER + asymmetric
 *     (left arm reaches lower than the right), gaunt thin limbs, splayed claw
 *     hands, and a slight sideways lean;
 *   • heavier / looser animation cadence (a limping shamble, a desperate lurch,
 *     a forward raking claw) so the swap from the crisp human stride is obvious.
 *
 * Clip names match exactly what `GltfCharacter` looks up (case-insensitive):
 *
 *   idle . walk . run . crawl . jump . swing . claw . stun . down
 *
 * (`claw` is the zombie's `attack`; `swing` exists for contract completeness —
 * a lurching arm swipe.) Every clip loops (first key == last key).
 *
 * Run with `node scripts/gen-zombie-glb.mjs`; it (re)writes
 * `client/public/models/zombie.glb`. Output is deterministic / byte-stable —
 * no Date.now(), no Math.random(), no network.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'client', 'public', 'models');
const OUT_FILE = join(OUT_DIR, 'zombie.glb');

/* -------------------------------------------------------------------------- */
/* glTF constants                                                              */
/* -------------------------------------------------------------------------- */

const FLOAT = 5126;
const USHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/* -------------------------------------------------------------------------- */
/* Binary accessor packing (identical scaffolding to gen-character-glb.mjs)    */
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
/* Geometry generators (all authored here — CC0 by construction)               */
/* -------------------------------------------------------------------------- */

/** Unit cube centered at the origin (1x1x1), reused for claws + feet. */
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

/**
 * UV sphere centered at the origin — the rounded, distinctly non-boxy head.
 * Normals are the normalized position (exact for a sphere). Poles are stitched
 * with triangles (not quads) exactly like three's SphereGeometry.
 */
function uvSphere(radius, widthSeg, heightSeg) {
  const pos = [];
  const nor = [];
  const idx = [];
  const grid = [];
  for (let iy = 0; iy <= heightSeg; iy++) {
    const row = [];
    const v = iy / heightSeg;
    const phi = v * Math.PI;
    for (let ix = 0; ix <= widthSeg; ix++) {
      const u = ix / widthSeg;
      const theta = u * Math.PI * 2;
      const x = -radius * Math.cos(theta) * Math.sin(phi);
      const y = radius * Math.cos(phi);
      const z = radius * Math.sin(theta) * Math.sin(phi);
      pos.push(x, y, z);
      const len = Math.hypot(x, y, z) || 1;
      nor.push(x / len, y / len, z / len);
      row.push(pos.length / 3 - 1);
    }
    grid.push(row);
  }
  for (let iy = 0; iy < heightSeg; iy++) {
    for (let ix = 0; ix < widthSeg; ix++) {
      const a = grid[iy][ix + 1];
      const b = grid[iy][ix];
      const c = grid[iy + 1][ix];
      const d = grid[iy + 1][ix + 1];
      if (iy !== 0) idx.push(a, b, d);
      if (iy !== heightSeg - 1) idx.push(b, c, d);
    }
  }
  return {
    pos: new Float32Array(pos),
    nor: new Float32Array(nor),
    idx: new Uint16Array(idx),
  };
}

/**
 * Tapered cylinder along +Y, centered at the origin — torso, pelvis, and the
 * gaunt limbs. Side normals carry the taper slope (proportional to
 * (h*cos, rBottom-rTop, h*sin)), so a cone shades correctly; flat caps get
 * axial normals.
 */
function cylinder(rTop, rBottom, height, radialSeg) {
  const pos = [];
  const nor = [];
  const idx = [];
  const half = height / 2;
  const slope = rBottom - rTop;
  const rings = [];
  for (let ring = 0; ring < 2; ring++) {
    const row = [];
    const radius = ring === 0 ? rBottom : rTop;
    const yy = ring === 0 ? -half : half;
    for (let ix = 0; ix <= radialSeg; ix++) {
      const theta = (ix / radialSeg) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      pos.push(radius * cos, yy, radius * sin);
      const nx = height * cos;
      const ny = slope;
      const nz = height * sin;
      const l = Math.hypot(nx, ny, nz) || 1;
      nor.push(nx / l, ny / l, nz / l);
      row.push(pos.length / 3 - 1);
    }
    rings.push(row);
  }
  for (let ix = 0; ix < radialSeg; ix++) {
    const a = rings[0][ix];
    const b = rings[0][ix + 1];
    const c = rings[1][ix + 1];
    const d = rings[1][ix];
    idx.push(a, b, d, b, c, d);
  }
  // Flat end caps (skipped when a radius is 0 — i.e. a pointed cone).
  const cap = (yy, radius, ny) => {
    const center = pos.length / 3;
    pos.push(0, yy, 0);
    nor.push(0, ny, 0);
    const start = pos.length / 3;
    for (let ix = 0; ix <= radialSeg; ix++) {
      const theta = (ix / radialSeg) * Math.PI * 2;
      pos.push(radius * Math.cos(theta), yy, radius * Math.sin(theta));
      nor.push(0, ny, 0);
    }
    for (let ix = 0; ix < radialSeg; ix++) {
      const a = start + ix;
      const b = start + ix + 1;
      if (ny > 0) idx.push(center, a, b);
      else idx.push(center, b, a);
    }
  };
  if (rTop > 0) cap(half, rTop, 1);
  if (rBottom > 0) cap(-half, rBottom, -1);
  return {
    pos: new Float32Array(pos),
    nor: new Float32Array(nor),
    idx: new Uint16Array(idx),
  };
}

/* -------------------------------------------------------------------------- */
/* Meshes — many primitives, ONE shared material (all reference material 0)    */
/* -------------------------------------------------------------------------- */

const meshes = [];
/** Local-space AABB per mesh index, for the base-pose height/feet sanity print. */
const meshBounds = [];

/** Pack a geometry as accessors + a mesh (material 0) and return the mesh index. */
function addMesh(name, geo) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < geo.pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const val = geo.pos[i + k];
      if (val < min[k]) min[k] = val;
      if (val > max[k]) max[k] = val;
    }
  }
  const posAcc = addAccessor(geo.pos, FLOAT, 'VEC3', { target: ARRAY_BUFFER, min, max });
  const norAcc = addAccessor(geo.nor, FLOAT, 'VEC3', { target: ARRAY_BUFFER });
  const idxAcc = addAccessor(geo.idx, USHORT, 'SCALAR', { target: ELEMENT_ARRAY_BUFFER });
  const meshIndex = meshes.length;
  meshes.push({
    name,
    primitives: [
      { attributes: { POSITION: posAcc, NORMAL: norAcc }, indices: idxAcc, material: 0 },
    ],
  });
  meshBounds[meshIndex] = { min, max, pos: geo.pos };
  return meshIndex;
}

const HEAD = addMesh('Head', uvSphere(0.19, 14, 10));
const JAW = addMesh('Jaw', uvSphere(0.1, 10, 6));
const TORSO = addMesh('Torso', cylinder(0.15, 0.2, 0.58, 12));
const PELVIS = addMesh('Pelvis', cylinder(0.2, 0.15, 0.2, 12));
const ARM_L = addMesh('ArmLimbL', cylinder(0.05, 0.038, 0.72, 8)); // longer, gaunt
const ARM_R = addMesh('ArmLimbR', cylinder(0.055, 0.042, 0.58, 8)); // shorter (asymmetric)
const LEG = addMesh('LegLimb', cylinder(0.075, 0.05, 0.9, 8)); // thin, shared by both legs
const CLAW = addMesh('Claw', unitCube()); // reused for claws + feet

/* -------------------------------------------------------------------------- */
/* Material — a SINGLE shared neutral PBR material (runtime tints it green)     */
/* -------------------------------------------------------------------------- */

const materials = [
  {
    name: 'ZombieMat',
    doubleSided: true, // stylized placeholder: never show a back-face hole
    pbrMetallicRoughness: {
      baseColorFactor: [0.86, 0.85, 0.82, 1], // neutral light tone -> sickly-green tint reads
      metallicFactor: 0.05,
      roughnessFactor: 0.7,
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Quaternion helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Unit-axis quaternion [x,y,z,w] for a rotation of `angle` rad about `axis`. */
function quat(axis, angle) {
  const h = angle / 2;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}
/** Hamilton product a*b (apply b then a). */
function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const X = [1, 0, 0];
const Z = [0, 0, 1];

/* -------------------------------------------------------------------------- */
/* Node hierarchy — animated JOINTS + fixed pose nodes + leaf meshes           */
/* -------------------------------------------------------------------------- */
/*
 * The seven required joints (Root, HipsJoint, TorsoJoint, ArmLJoint, ArmRJoint,
 * LegLJoint, LegRJoint) are the ANIMATED pivots — clips rotate them. The
 * unmistakable-zombie silhouette lives in FIXED intermediate nodes the joints
 * compose on top of, so the hunch/lean/sling survive under EVERY clip:
 *   - Root carries a persistent sideways lean (never animated);
 *   - SpineHunch (under TorsoJoint) pitches the whole upper body forward;
 *   - ArmLLimb / ArmRLimb (under the shoulder joints) sling the arms forward,
 *     asymmetrically, and the arm meshes themselves differ in length;
 *   - the head leaf lolls (tilt + droop) and HeadJoint adds a lolling wobble.
 * Feet stay at y~0, HipsJoint at y=0.92, facing -Z.
 */

const nodes = [];
const nodeIndex = {};

function node(name, { t = [0, 0, 0], r, s, mesh, children } = {}) {
  const n = { name, translation: t };
  if (r) n.rotation = r;
  if (s) n.scale = s;
  if (mesh !== undefined) n.mesh = mesh;
  if (children) n.children = children;
  const i = nodes.length;
  nodes.push(n);
  nodeIndex[name] = i;
  return i;
}

/** Three splayed claw-blocks pointing forward (-Z), for a hand. */
function claws(prefix) {
  const c1 = node(`${prefix}Claw1`, { t: [-0.03, 0, -0.055], r: quat(Z, 0.28), s: [0.028, 0.028, 0.12], mesh: CLAW });
  const c2 = node(`${prefix}Claw2`, { t: [0, 0, -0.066], s: [0.03, 0.03, 0.13], mesh: CLAW });
  const c3 = node(`${prefix}Claw3`, { t: [0.03, 0, -0.055], r: quat(Z, -0.28), s: [0.028, 0.028, 0.12], mesh: CLAW });
  return [c1, c2, c3];
}

/* Upper-body leaves + detail. */
const torsoMesh = node('TorsoMesh', { t: [0, 0.27, 0], mesh: TORSO });
const pelvisMesh = node('PelvisMesh', { t: [0, 0.02, 0], mesh: PELVIS });
const headMesh = node('HeadMesh', { t: [0, 0.16, 0.03], r: quatMul(quat(Z, 0.4), quat(X, -0.18)), mesh: HEAD });
const jawMesh = node('JawMesh', { t: [0, 0.05, 0.14], r: quat(Z, 0.32), s: [0.9, 0.7, 1.0], mesh: JAW });
const headJoint = node('HeadJoint', { t: [0, 0.6, 0.0], children: [headMesh, jawMesh] });

/* Left arm: longer, hangs lower, slung a bit further forward (asymmetric). */
const handL = node('HandL', { t: [-0.015, -0.72, 0], children: claws('L') });
const armLMesh = node('ArmLMesh', { t: [0, -0.37, 0], mesh: ARM_L });
const armLLimb = node('ArmLLimb', { r: quatMul(quat(X, 0.78), quat(Z, 0.1)), children: [armLMesh, handL] });
const armLJoint = node('ArmLJoint', { t: [-0.2, 0.46, 0.0], children: [armLLimb] });

/* Right arm: shorter, higher, slightly less forward. */
const handR = node('HandR', { t: [0.015, -0.58, 0], children: claws('R') });
const armRMesh = node('ArmRMesh', { t: [0, -0.3, 0], mesh: ARM_R });
const armRLimb = node('ArmRLimb', { r: quatMul(quat(X, 0.52), quat(Z, -0.12)), children: [armRMesh, handR] });
const armRJoint = node('ArmRJoint', { t: [0.22, 0.4, 0.0], children: [armRLimb] });

/* Fixed forward hunch carries the whole upper body; TorsoJoint animates above it. */
const spineHunch = node('SpineHunch', {
  r: quat(X, -0.55),
  children: [torsoMesh, headJoint, armLJoint, armRJoint],
});
const torsoJoint = node('TorsoJoint', { t: [0, 0.06, 0], children: [spineHunch] });

/* Legs: gaunt, thin, reaching to the floor; splayed feet as claw-blocks. */
const footL = node('FootL', { t: [0.0, -0.875, -0.05], s: [0.13, 0.09, 0.3], mesh: CLAW });
const legLMesh = node('LegLMesh', { t: [0, -0.46, 0], mesh: LEG });
const legLJoint = node('LegLJoint', { t: [-0.12, 0, 0], children: [legLMesh, footL] });

const footR = node('FootR', { t: [0.0, -0.875, -0.05], s: [0.13, 0.09, 0.3], mesh: CLAW });
const legRMesh = node('LegRMesh', { t: [0, -0.46, 0], mesh: LEG });
const legRJoint = node('LegRJoint', { t: [0.13, 0, 0], children: [legRMesh, footR] });

/* Hips (required joint) carry pelvis + torso + legs; Root carries a fixed lean. */
const hipsJoint = node('HipsJoint', {
  t: [0, 0.92, 0],
  children: [pelvisMesh, torsoJoint, legLJoint, legRJoint],
});
const rootNode = node('Root', { r: quat(Z, 0.05), children: [hipsJoint] });

/* -------------------------------------------------------------------------- */
/* Animation clips — one per EntityState, all looping, heavier/looser cadence  */
/* -------------------------------------------------------------------------- */

const animations = [];

/**
 * Build one named clip from single-axis rotation channels. Each channel targets
 * one joint at most once (glTF forbids two channels sharing a node+path).
 * `keys` = [[t, axis, angle], ...]; LINEAR sampler; first key == last key loops.
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

/** Asymmetric swing (forward amp != back amp) — the dragging, limping cadence. */
const drag = (joint, fwd, back, dur, axis = X) => ({
  joint,
  keys: [
    [0, axis, 0],
    [dur * 0.25, axis, fwd],
    [dur * 0.5, axis, 0],
    [dur * 0.75, axis, -back],
    [dur, axis, 0],
  ],
});
/** Static pose the mixer simply holds (loops trivially). */
const hold = (joint, axis, angle, dur = 1) => ({
  joint,
  keys: [[0, axis, angle], [dur, axis, angle]],
});
/** 3-key wobble about `axis`: c+a -> c-a -> c+a (first==last). */
const wobble = (joint, amp, dur, axis = X, center = 0) => ({
  joint,
  keys: [
    [0, axis, center + amp],
    [dur * 0.5, axis, center - amp],
    [dur, axis, center + amp],
  ],
});

// idle — slow labored sway, head lolling loosely.
clip('idle', [
  wobble('TorsoJoint', 0.045, 1.8, Z),
  { joint: 'HeadJoint', keys: [[0, Z, 0.06], [0.6, Z, -0.06], [1.2, Z, 0.08], [1.8, Z, 0.06]] },
  { joint: 'ArmLJoint', keys: [[0, X, 0.06], [0.9, X, -0.05], [1.8, X, 0.06]] },
  { joint: 'ArmRJoint', keys: [[0, X, -0.05], [0.9, X, 0.06], [1.8, X, -0.05]] },
]);

// walk — a SHAMBLE: uneven dragging legs, arms hanging forward swaying loosely.
clip('walk', [
  drag('LegLJoint', 0.5, 0.35, 1.1),
  drag('LegRJoint', 0.3, 0.22, 1.1, X),
  { joint: 'ArmLJoint', keys: [[0, X, 0.15], [0.55, X, -0.15], [1.1, X, 0.15]] },
  { joint: 'ArmRJoint', keys: [[0, X, -0.12], [0.55, X, 0.18], [1.1, X, -0.12]] },
  wobble('TorsoJoint', 0.06, 1.1, Z),
]);

// run — a faster desperate lurch, more hunch, head bobbing.
clip('run', [
  drag('LegLJoint', 0.8, 0.6, 0.8),
  drag('LegRJoint', 0.6, 0.8, 0.8),
  { joint: 'ArmLJoint', keys: [[0, X, 0.5], [0.4, X, -0.4], [0.8, X, 0.5]] },
  { joint: 'ArmRJoint', keys: [[0, X, -0.4], [0.4, X, 0.5], [0.8, X, -0.4]] },
  hold('TorsoJoint', X, -0.25, 0.8),
  { joint: 'HeadJoint', keys: [[0, X, 0.1], [0.4, X, -0.05], [0.8, X, 0.1]] },
]);

// crawl — dragging along the ground, arms clawing forward, legs trailing.
clip('crawl', [
  hold('HipsJoint', X, -1.15, 1.4),
  hold('TorsoJoint', X, 0.35, 1.4),
  { joint: 'ArmLJoint', keys: [[0, X, -0.2], [0.7, X, 0.5], [1.4, X, -0.2]] },
  { joint: 'ArmRJoint', keys: [[0, X, 0.5], [0.7, X, -0.2], [1.4, X, 0.5]] },
  { joint: 'LegLJoint', keys: [[0, X, 0.0], [0.7, X, 0.22], [1.4, X, 0.0]] },
  { joint: 'LegRJoint', keys: [[0, X, 0.0], [0.7, X, -0.22], [1.4, X, 0.0]] },
]);

// jump — a lunge/leap, arms flailing up, head thrown back.
clip('jump', [
  hold('LegLJoint', X, 0.7, 0.9),
  hold('LegRJoint', X, 0.55, 0.9),
  { joint: 'ArmLJoint', keys: [[0, X, 1.2], [0.45, X, 2.3], [0.9, X, 1.2]] },
  { joint: 'ArmRJoint', keys: [[0, X, 1.5], [0.45, X, 2.5], [0.9, X, 1.5]] },
  hold('TorsoJoint', X, 0.15, 0.9),
  hold('HeadJoint', X, -0.2, 0.9),
]);

// swing — a lurching arm swipe (contract completeness).
clip('swing', [
  { joint: 'ArmRJoint', keys: [[0, X, 2.5], [0.5, X, 0.2], [1, X, 2.5]] },
  hold('ArmLJoint', X, 0.5, 1),
  wobble('TorsoJoint', 0.15, 1, Z, -0.03),
  { joint: 'HipsJoint', keys: [[0, Z, -0.05], [0.5, Z, 0.08], [1, Z, -0.05]] },
]);

// claw — the signature zombie attack: arms rake out ahead alternating; body dives.
clip('claw', [
  { joint: 'ArmLJoint', keys: [[0, X, 1.1], [0.5, X, 2.0], [1, X, 1.1]] },
  { joint: 'ArmRJoint', keys: [[0, X, 2.0], [0.5, X, 1.1], [1, X, 2.0]] },
  { joint: 'TorsoJoint', keys: [[0, X, -0.1], [0.5, X, -0.4], [1, X, -0.1]] },
  { joint: 'HeadJoint', keys: [[0, X, 0.0], [0.5, X, 0.2], [1, X, 0.0]] },
]);

// stun — a rattled shudder/wobble.
clip('stun', [
  { joint: 'HipsJoint', keys: [[0, Z, 0.1], [0.22, Z, -0.12], [0.45, Z, 0.12], [0.68, Z, -0.1], [0.9, Z, 0.1]] },
  { joint: 'HeadJoint', keys: [[0, Z, 0.15], [0.3, Z, -0.15], [0.6, Z, 0.15], [0.9, Z, 0.15]] },
  { joint: 'ArmLJoint', keys: [[0, X, 0.2], [0.3, X, -0.2], [0.6, X, 0.2], [0.9, X, 0.2]] },
  { joint: 'ArmRJoint', keys: [[0, X, -0.2], [0.3, X, 0.2], [0.6, X, -0.2], [0.9, X, -0.2]] },
]);

// down — collapse folded flat near the ground.
clip('down', [
  hold('HipsJoint', X, -1.5, 1.2),
  hold('TorsoJoint', X, -0.15, 1.2),
  hold('ArmLJoint', X, 0.4, 1.2),
  hold('ArmRJoint', X, 0.5, 1.2),
  hold('LegLJoint', X, 0.1, 1.2),
  hold('LegRJoint', X, -0.1, 1.2),
]);

/* -------------------------------------------------------------------------- */
/* Base-pose AABB (sanity print only): confirm ~1.8 m tall, feet at y~0         */
/* -------------------------------------------------------------------------- */

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function compose(t, q, s) {
  const [x, y, z, w] = q;
  const [sx, sy, sz] = s;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy - wz) * sy, (xz + wy) * sz, t[0],
    (xy + wz) * sx, (1 - (xx + zz)) * sy, (yz - wx) * sz, t[1],
    (xz - wy) * sx, (yz + wx) * sy, (1 - (xx + yy)) * sz, t[2],
    0, 0, 0, 1,
  ];
}
function matMul(a, b) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] =
        a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  return o;
}
const tpY = (m, p) => m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7];

let minY = Infinity;
let maxY = -Infinity;
function walk(index, parent) {
  const n = nodes[index];
  const world = matMul(parent, compose(n.translation, n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1]));
  if (n.mesh !== undefined) {
    const p = meshBounds[n.mesh].pos;
    for (let i = 0; i < p.length; i += 3) {
      const wy = tpY(world, [p[i], p[i + 1], p[i + 2]]);
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
  }
  for (const c of n.children ?? []) walk(c, world);
}
walk(rootNode, IDENTITY);

/* -------------------------------------------------------------------------- */
/* Assemble + write the GLB (identical container format to the human export)   */
/* -------------------------------------------------------------------------- */

const gltf = {
  asset: { version: '2.0', generator: 'the-crawling-dark gen-zombie-glb.mjs (CC0)' },
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
  `wrote ${OUT_FILE} (${out.length} bytes) — ${nodes.length} nodes, ${meshes.length} meshes, ` +
    `${animations.length} clips: ${animations.map((a) => a.name).join(', ')}`,
);
// eslint-disable-next-line no-console
console.log(
  `base pose: height ${maxY.toFixed(3)} m, feet y ${minY.toFixed(3)} m (hunched — head sits low)`,
);
