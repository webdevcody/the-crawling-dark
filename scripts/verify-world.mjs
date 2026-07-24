/**
 * M9 world-model verification harness (not shipped; run manually / in CI).
 *
 * The shared package is TypeScript, so bundle it to ESM first, then point this
 * harness at the bundle (defaults to /tmp/shared.mjs, override with SHARED_BUNDLE):
 *   esbuild shared/src/index.ts --bundle --format=esm --outfile=/tmp/shared.mjs
 *   node scripts/verify-world.mjs
 *
 * Checks the invariants the whole game leans on across many seeds:
 *  - determinism (same seed → identical world on a second generate),
 *  - spawn safety (player ring + NPC corner are collision-clear),
 *  - the lake clears the plaza and stays inside the town,
 *  - trees never overlap the plaza/spawns/lake/buildings,
 *  - the perimeter forest is genuinely walk-through-proof (a radial probe from
 *    inside the town toward each edge is stopped before the wall clamp),
 *  - collideCircleXZ keeps a body out of every solid.
 */
const { generateWorld, collideCircleXZ, buildingAABB, MAP_SIZE, PLAYER_RADIUS } =
  await import(process.env.SHARED_BUNDLE ?? '/tmp/shared.mjs');

const HALF = MAP_SIZE / 2;
const SPAWN_RING_RADIUS = 4;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const NPC_INSET = 5;
const PLAZA_RADIUS = 12;

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('  ✗ ' + msg);
};

function distSqToAABB(x, z, a) {
  const dx = x < a.minX ? a.minX - x : x > a.maxX ? x - a.maxX : 0;
  const dz = z < a.minZ ? a.minZ - z : z > a.maxZ ? z - a.maxZ : 0;
  return dx * dx + dz * dz;
}

// Deep structural equality good enough for the plain-data World.
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SEEDS = [1, 2, 3, 7, 42, 100, 1337, 99999, 2 ** 31 - 1, 0];
let treeCounts = [];
let bldgCounts = [];
let heightSpans = [];

for (const seed of SEEDS) {
  const w = generateWorld(seed);
  const w2 = generateWorld(seed);

  // 1. Determinism.
  if (!eq(w, w2)) fail(`seed ${seed}: non-deterministic (two generates differ)`);

  treeCounts.push(w.trees.length);
  const realBuildings = w.buildings.filter(
    (b) => !(b.hw >= w.half || b.hd >= w.half),
  );
  bldgCounts.push(realBuildings.length);
  const heights = realBuildings.map((b) => b.height);
  heightSpans.push([Math.min(...heights), Math.max(...heights)]);

  // 2. Lake clears the plaza and sits inside the town.
  if (w.water) {
    const { cx, cz, radius } = w.water;
    const centerDist = Math.hypot(cx, cz);
    if (centerDist - radius <= PLAZA_RADIUS)
      fail(`seed ${seed}: lake reaches into the plaza (${(centerDist - radius).toFixed(1)}m)`);
    if (Math.abs(cx) + radius > 54 || Math.abs(cz) + radius > 54)
      fail(`seed ${seed}: lake spills past the town half (TOWN_HALF=54)`);
  }

  // 3. Player spawn ring is collision-clear (spawn == resolved spawn).
  for (let id = 0; id < 12; id++) {
    const a = id * GOLDEN_ANGLE;
    const sx = Math.cos(a) * SPAWN_RING_RADIUS;
    const sz = Math.sin(a) * SPAWN_RING_RADIUS;
    const r = collideCircleXZ(w, sx, sz, PLAYER_RADIUS);
    if (Math.hypot(r.x - sx, r.z - sz) > 1e-6)
      fail(`seed ${seed}: player spawn ${id} not clear (pushed ${Math.hypot(r.x - sx, r.z - sz).toFixed(2)}m)`);
  }

  // 4. NPC spawn corner: after ONE resolve it must be a stable, clear point
  //    (a second resolve shouldn't move it — i.e. it's not left inside a tree).
  const ex = HALF - NPC_INSET;
  const s1 = collideCircleXZ(w, ex, ex, PLAYER_RADIUS);
  const s2 = collideCircleXZ(w, s1.x, s1.z, PLAYER_RADIUS);
  if (Math.hypot(s2.x - s1.x, s2.z - s1.z) > 1e-6)
    fail(`seed ${seed}: NPC spawn not stable after resolve (still inside a solid)`);

  // 5. Trees don't overlap plaza / player spawns / buildings.
  for (const t of w.trees) {
    if (Math.hypot(t.x, t.z) < PLAZA_RADIUS + t.radius)
      fail(`seed ${seed}: tree ${t.id} intrudes on the plaza`);
    for (const b of realBuildings) {
      if (distSqToAABB(t.x, t.z, buildingAABB(b)) < t.radius * t.radius)
        fail(`seed ${seed}: tree ${t.id} overlaps building ${b.id}`);
    }
  }

  // 6. Forest is walk-through-proof: from a point inside the ring road, step a
  //    body straight out toward each of the 4 edges and 4 corners; collision must
  //    stop it short of the wall-clamp limit (so trees, not the bare wall, hold it).
  const clampLimit = w.half - w.wallThickness - PLAYER_RADIUS;
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
  ];
  for (const [dx, dz] of dirs) {
    // Skip the NPC-spawn corner direction (deliberately an open clearing).
    const towardNpcCorner = dx > 0.5 && dz > 0.5;
    let px = 20 * dx;
    let pz = 20 * dz;
    // March outward in small steps, resolving collision each step.
    for (let i = 0; i < 400; i++) {
      const nx = px + dx * 0.25;
      const nz = pz + dz * 0.25;
      const r = collideCircleXZ(w, nx, nz, PLAYER_RADIUS);
      px = r.x;
      pz = r.z;
    }
    const reached = Math.max(Math.abs(px), Math.abs(pz));
    if (!towardNpcCorner && reached >= clampLimit - 0.05)
      fail(`seed ${seed}: forest let a body reach the wall clamp along (${dx},${dz}) → ${reached.toFixed(2)}m`);
  }
}

const min = (a) => Math.min(...a);
const max = (a) => Math.max(...a);
console.log(`\nseeds checked: ${SEEDS.length}`);
console.log(`trees/world:      ${min(treeCounts)}..${max(treeCounts)}`);
console.log(`buildings/world:  ${min(bldgCounts)}..${max(bldgCounts)} (excl. 4 wall slabs)`);
console.log(
  `bldg height span: ${min(heightSpans.map((h) => h[0])).toFixed(1)}..${max(heightSpans.map((h) => h[1])).toFixed(1)} m`,
);

if (failures === 0) console.log('\n✓ all world invariants hold');
else {
  console.error(`\n✗ ${failures} invariant failure(s)`);
  process.exit(1);
}
