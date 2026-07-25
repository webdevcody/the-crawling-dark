# 🧟 The Crawling Dark — Design of Record

> This document is the design of record for The Crawling Dark, copied from the detailed plan in issue #1.

## Detailed Implementation Plan

Here's a fleshed-out plan for the game described in the issue. It locks down the fuzzy rules into concrete, tunable numbers, proposes an authoritative-server architecture, and breaks the work into shippable milestones. Anything marked **⚠️ Decision needed** is a spot where I made a reasonable default but want your call.

---

### 1. Game design — locking down the rules

**Concept.** Up to ~12 players spawn in a dark town. One NPC zombie ("patient zero") hunts them. Survive **5 minutes** and the humans win. Get caught and you *join the horde* — the longer the round runs, the more dangerous it gets. If everyone is turned, the zombies win.

**Player states & controls**

| Action | Key | Behavior |
|---|---|---|
| Walk | `W A S D` | Default move, ~3.5 m/s |
| Run | hold `Shift` | ~6.5 m/s, drains stamina (⚠️ stamina optional — see below) |
| Crawl | hold `C` (toggle) | ~1.5 m/s, low profile: smaller hitbox, quieter, can slip under some obstacles |
| Jump | `Space` | ~1.2 m impulse, can't change state mid-air |
| Attack | `Left click` | Baseball-bat swing, ~120° arc, short range, cooldown |
| Look | mouse | Camera / aim |

**Combat rules**
- **Zombies infect, they don't "kill."** A zombie that lands a hit on a human downs them; after a short death-cam the player **respawns as a zombie on the zombie team** for the rest of the round.
- **Zombies have infinite lives.** So the bat can't permanently remove a zombie. Instead the bat is a **defensive/crowd-control tool**: a hit **knocks the zombie back and stuns it** for ~1.5s, buying time to escape. This keeps the human win-condition purely about *survival*, not *kills*.
- **Crawling is stealth.** Zombies acquire targets partly by line-of-sight; crawlers are harder to spot and present a smaller hitbox — the risk is you're slow. (Fits the "Crawling Dark" theme.)

**Zombie behavior**
- Round starts with **1 NPC zombie**. The horde grows only from turned players.
- NPC AI: seek the nearest visible human, path around buildings, attack on contact. Turned-player zombies are human-controlled with the same movement set (minus the bat; they get a lunge/claw attack).

**Round lifecycle**

```
LOBBY ──(≥2 players ready)──▶ COUNTDOWN(10s) ──▶ ACTIVE(5:00) ──▶ ROUND_END(10s) ──▶ LOBBY
```
- **Humans win** if the 5:00 timer expires with ≥1 human alive.
- **Zombies win** if all humans are turned before the timer expires.
- On death → become zombie (no spectating unless you're already out and the round has no humans left).

**⚠️ Decisions needed**
1. **Stamina on sprint?** (Adds depth; adds tuning work.) Default: *yes, simple stamina bar.*
2. **Camera:** first-person or third-person? Default: *third-person over-the-shoulder* (easier to read the bat swing and see zombies behind you).
3. **Player count / rooms:** single shared game room for MVP, or matchmaking into rooms of N? Default: *single room, cap 12, spillover spectates.*
4. **Friendly fire / bat vs other humans?** Default: *no friendly fire.*
5. **Respawn-as-zombie delay** and whether turned zombies can be bat-stunned too. Default: *3s delay, yes they can be stunned.*

---

### 2. Technical architecture

**Authoritative server.** The server owns all game state and simulates movement, collision, combat, AI, and the round clock. Clients send *inputs*, receive *state snapshots*. This prevents cheating (speed/teleport/hit hacks) and keeps everyone in sync — essential for a PvP infection game.

**Rates**
- Server simulation tick: **30 Hz** (33 ms fixed timestep).
- Snapshot broadcast: **~15–20 Hz** (delta-compressed later).
- Client render: **60 fps** with **~100 ms interpolation buffer** for remote entities.

**Latency hiding**
- **Client-side prediction** for the local player (apply your own input immediately, reconcile against server).
- **Entity interpolation** for everyone else (render them slightly in the past, smoothly).
- MVP can ship with *interpolation only* and add prediction in a later milestone if input feels laggy.

**Stack**

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere | Shared types across client/server catch protocol drift |
| Client render | **Three.js** (r160+) | As requested |
| Client build | **Vite** | Fast dev server + HMR |
| Server | **Node.js + `ws`** | Simple, battle-tested WebSocket lib; swap to `uWebSockets.js` if we need more throughput |
| Shared | workspace `shared/` package | Constants, message types, and pure sim math reused by both sides |
| Monorepo | **pnpm workspaces** | Clean client/server/shared separation |

**Repo layout**

```
the-crawling-dark/
├─ package.json            # pnpm workspace root
├─ shared/                 # imported by both client & server
│  ├─ constants.ts         # tick rate, speeds, map size, round length
│  ├─ protocol.ts          # message type enums + payload interfaces
│  ├─ math.ts              # vec3 helpers, collision primitives
│  └─ sim.ts               # pure movement/collision step (shared by predict + server)
├─ server/
│  ├─ index.ts             # ws server, connection lifecycle
│  ├─ game/
│  │  ├─ Room.ts           # one game instance, tick loop
│  │  ├─ Player.ts, Zombie.ts
│  │  ├─ ai.ts             # zombie steering/pathfinding
│  │  ├─ round.ts          # state machine + timer
│  │  └─ world.ts          # town geometry + collision queries
│  └─ net/encode.ts        # snapshot (de)serialization
├─ client/
│  ├─ index.html
│  ├─ main.ts              # bootstrap
│  ├─ net/Connection.ts    # ws client, reconnect, ping
│  ├─ scene/              # renderer, camera, lighting, fog
│  ├─ entities/           # player/zombie meshes + animation
│  ├─ input/Controls.ts    # keybinds → input frames
│  ├─ predict/            # local prediction + reconciliation
│  └─ ui/HUD.ts            # timer, alive count, team, stamina
└─ docs/DESIGN.md          # this plan, kept in-repo
```

---

### 3. Network protocol

JSON to start (readable, fast to build); a clear path to binary/delta later. Every message is `{ t: <type>, ...payload }`.

**Client → Server**
```ts
JOIN     { name: string }
INPUT    { seq: number, keys: bitmask, yaw: number, dt: number }  // sent every client frame
ATTACK   { seq: number }                                          // bat swing
READY    { ready: boolean }                                        // lobby
PING     { id: number }
```

**Server → Client**
```ts
WELCOME    { playerId, tickRate, mapSeed }
SNAPSHOT   { tick, entities: [{ id, kind, x,y,z, yaw, state, hp/turned }], events: [...] }
EVENT      { kind: 'attack'|'infect'|'stun'|'jump'|'roundStart'|'roundEnd', ... }
ROUND      { phase, timeLeftMs, humansAlive, zombieCount, winner? }
PONG       { id }
```

`INPUT` uses a **bitmask** for held keys (fwd/back/left/right/run/crawl/jump) plus `yaw` and a client `seq` number the server echoes in snapshots so prediction can reconcile.

**Optimization path (later milestone):** switch payloads to `ArrayBuffer`, quantize positions to 16-bit, delta-encode against last acked snapshot, and only send entities in interest range. Not needed for MVP correctness.

---

### 4. World & collision

- **Town** = a bounded grid of building AABBs (boxes) around streets and a central square, with a perimeter wall so no one runs off the map. Built from a seed so client and server agree.
- **Natural/urban features (M9 · t9a).** The same seed also produces solid **trees** (circular XZ colliders), one **lake** (a circular water region), and a decorative **road** grid. These live on the `World` beside `buildings`/`colliders` and, like everything else, are byte-for-byte identical on client and server (generated from an independent `seed ^ 0x9e3779b9` PRNG stream, so the earlier per-seed building layout is unchanged).
- **2.5D collision** (big simplification): players are cylinders on a flat ground plane; collision is resolved on the **XZ plane** as **circle-vs-AABB** for buildings and **circle-vs-circle** for trees (and the lake shoreline), with `Y` handled separately for jump gravity. This avoids a full 3D physics engine while still feeling solid.
- **Water rule = `blocked`** (`World.waterMode`): the lake is a solid shoreline you cannot cross, resolved in `collideCircleXZ` exactly like a tree. (`'slow'` deep water is left as a future seam handled in the sim, not in collision.)
- Roads are **non-colliding** — render/layout data only (drawn in t9e, refined in t9b) — and are intentionally not added to `colliders`.
- Trees and the lake are kept OUT of the AABB `colliders` list, so the nav grid and AI ray casts (`raycastBuildings`/`hasLineOfSight`) stay building-only until M9 · t9f wires the new obstacles into AI perception.
- MVP uses box meshes for buildings; swap in GLTF town assets later without touching collision (collision reads the same collider lists).

---

### 5. Server simulation

**Fixed-timestep loop** (`setInterval` at 30 Hz, accumulator for drift):
1. Drain queued client inputs.
2. Step each player: apply movement from `sim.ts`, resolve collisions, gravity/jump.
3. Step zombie AI (seek + avoid + attack).
4. Resolve bat swings (arc/cone hit test → stun+knockback).
5. Resolve infections (zombie contact with human → schedule turn).
6. Advance round state machine + timer, check win/lose.
7. Every ~2nd tick: build & broadcast a snapshot.

**Zombie AI (MVP):** steering — seek nearest *visible* human, avoid buildings via short raycasts, attack when within contact range. Upgrade to **grid A\*** over a nav grid if steering gets stuck on concave corners.

**Combat resolution:** bat swing = cone test (range + half-angle) against zombies in front; on hit apply knockback impulse + stun timer. Infection = capsule overlap between a zombie and a human during the zombie's attack window.

---

### 6. Client

- **Scene:** dark ambient + a few street lights, **fog** for the "crawling dark" mood and to hide pop-in, moon/directional light for shape.
- **Camera:** third-person spring-arm that avoids clipping into walls.
- **Entities:** capsule/box placeholders first, then rigged GLTF with animation states (idle/walk/run/crawl/jump/swing). Remote entities interpolated from the snapshot buffer.
- **Input:** poll keys each frame → build an `INPUT` frame with a `seq`, send to server, and (once prediction lands) apply locally immediately.
- **HUD:** round timer, humans-alive count, your team, stamina bar, and a kill/turn feed.

---

### 7. Milestones (each independently demoable)

| # | Milestone | Acceptance criteria | Rough size |
|---|---|---|---|
| **M0** | Scaffold | pnpm workspace, Vite client shows a Three.js scene, `ws` server accepts a connection, shared package imports on both sides | S |
| **M1** | Networking spine | Join/leave, player IDs, snapshot broadcast, ping/RTT display; two browser tabs see each other as boxes moving | M |
| **M2** | Movement & world | Town map, walk/run/crawl/jump with server-side collision, remote interpolation, third-person camera | L |
| **M3** | Combat & infection | Bat swing (stun+knockback), zombie contact turns humans, death→zombie flow | M |
| **M4** | Zombie AI | NPC patient-zero seeks/paths/attacks; feels threatening but escapable | M |
| **M5** | Round loop | Lobby→countdown→5:00 active→end, win/lose conditions, HUD timer + alive count | M |
| **M6** | Prediction & polish | Client prediction + reconciliation, stamina, animations, audio, fog/lighting pass | L |
| **M7** | Netcode optimization | Binary/delta snapshots, interest management, reconnect | M *(optional for a fun MVP)* |

A **playable-fun MVP is M0–M5.** M6–M7 make it feel good and scale.

---

### 8. Risks & mitigations
- **Netcode complexity** → start interpolation-only; add prediction in M6, not M0.
- **Zombie pathing getting stuck** → ship steering first, keep A\* as a known upgrade.
- **Scope creep on art** → box placeholders gate every gameplay milestone; art is swappable and never blocks logic.
- **Physics rabbit hole** → deliberately 2.5D, no full physics engine.

---

### 9. Suggested first PR (M0)
Set up the pnpm monorepo, a Vite Three.js client rendering a lit ground plane, a `ws` server that logs connects, and a `shared/constants.ts` both import — proving the whole toolchain end-to-end before any gameplay.

---

## Constants reference

The tunables below are defined once in `shared/src/constants.ts` and imported by
both the client and the server, so changing a value here changes it everywhere
without duplication. Values match the "locked" numbers above.

### Simulation & networking rates

| Constant | Meaning | Value |
|---|---|---|
| `TICK_RATE` | Server simulation ticks per second (fixed timestep) | `30` |
| `TICK_MS` | Milliseconds per simulation tick (derived) | `1000 / TICK_RATE` ≈ `33.33` |
| `SNAPSHOT_RATE` | Snapshots broadcast to clients per second | `15` |
| `SNAPSHOT_MS` | Milliseconds between snapshots (derived) | `1000 / SNAPSHOT_RATE` ≈ `66.67` |
| `SNAPSHOT_TICK_INTERVAL` | Sim ticks between snapshots (derived) | `2` |
| `CLIENT_FPS` | Target client render frame rate | `60` |
| `INTERP_BUFFER_MS` | Remote-entity interpolation buffer (ms) | `100` |

### Movement

| Constant | Meaning | Value |
|---|---|---|
| `MOVE_SPEED_CRAWL` | Crawl speed (m/s) | `1.5` |
| `MOVE_SPEED_WALK` | Walk speed (m/s) | `3.5` |
| `MOVE_SPEED_RUN` | Run speed (m/s) | `6.5` |
| `JUMP_VELOCITY` | Upward jump velocity (m/s, ~1.2 m peak) | `6.6` |
| `GRAVITY` | Downward acceleration (m/s²) | `18.0` |
| `PLAYER_RADIUS` | Collision cylinder radius (m) | `0.4` |
| `PLAYER_HEIGHT` | Standing capsule height (m) | `1.8` |
| `CRAWL_HEIGHT` | Crawling capsule height (m) | `0.9` |

### Combat & infection

| Constant | Meaning | Value |
|---|---|---|
| `ATTACK_COOLDOWN_MS` | Cooldown between bat swings (ms) | `800` |
| `BAT_RANGE` | Bat swing reach from attacker (m) | `2.0` |
| `BAT_ARC_DEG` | Full bat swing cone width (degrees) | `120` |
| `STUN_DURATION_MS` | Stun applied by a bat hit (ms) | `1500` |
| `BAT_KNOCKBACK` | Knockback impulse on a bat hit (m/s) | `8.0` |
| `INFECTION_CONTACT_RADIUS` | Zombie-to-human infection radius (m) | `1.0` |
| `RESPAWN_DELAY_MS` | Delay before a downed human turns zombie (ms) | `3000` |

### Round lifecycle

| Constant | Meaning | Value |
|---|---|---|
| `MIN_PLAYERS_TO_START` | Ready players required to start | `2` |
| `MAX_PLAYERS` | Max players per room (spillover spectates) | `12` |
| `COUNTDOWN_SEC` | Pre-round countdown (s) | `10` |
| `COUNTDOWN_MS` | Pre-round countdown (ms, derived) | `10000` |
| `ROUND_LENGTH_SEC` | Active round length (s, 5:00) | `300` |
| `ROUND_LENGTH_MS` | Active round length (ms, derived) | `300000` |
| `ROUND_END_SEC` | Post-round scoreboard length (s) | `10` |
| `ROUND_END_MS` | Post-round scoreboard length (ms, derived) | `10000` |

### World & server

| Constant | Meaning | Value |
|---|---|---|
| `MAP_SIZE` | Square town size in world units (spans ±MAP_SIZE/2 on X/Z) | `128` |
| `DEFAULT_SERVER_PORT` | Default authoritative WebSocket server port | `8080` |

---

## M8 tuning notes (Phase 2 — Movement Feel & Performance)

Milestone **M8** attacks walk-around jitter and frame-time stability. The perceived
smoothness comes almost entirely from the **client** side; the wire rates below were
re-evaluated and deliberately left unchanged.

### Client prediction & interpolation (t8a–t8d)

- **Fixed-timestep prediction (t8a).** The local player now predicts in fixed
  `TICK_MS` sub-steps driven by an accumulator that mirrors the server's loop, so
  client and server integrate the *same* `dt` and no longer drift between
  reconciles. INPUT is pumped from that same accumulator, which also **decouples the
  input send-rate from the frame-rate (t8c)** — ~`TICK_RATE` sends/s at 30, 60, or
  144 fps.
- **Reconciliation error-smoothing (t8b).** A correction is folded into a decaying
  render offset (half-life ≈ 45 ms, ~5–8 frames) instead of snapping the body;
  corrections past `SNAP_DIST` (1.75 m — a real teleport/respawn) still snap.
- **Adaptive interpolation + extrapolation (t8d).** The remote-entity interpolation
  delay adapts to measured inter-arrival jitter within a band seeded on
  `INTERP_BUFFER_MS` (`INTERP_DELAY_MIN_MS` … `INTERP_DELAY_MAX_MS`), and a late
  snapshot is briefly extrapolated (≤ `INTERP_EXTRAPOLATION_CAP_MS`) rather than
  frozen, killing the old freeze-then-jump stutter.

### Frame budget (t8e)

- **Target: one render frame ≤ `1000 / CLIENT_FPS` ≈ 16.7 ms (60 fps)**, held with a
  full `MAX_PLAYERS` (12) + NPC room. A *stable* frame time — a flat p95 near the
  budget — is what makes walking read as smooth, more than a high peak fps.
- A toggleable perf overlay (backtick `` ` `` key) reports FPS, mean + **p95 frame
  time** vs. that budget, and draw calls / triangles from `renderer.info`.
- The `sample → sync → override` hot path was made allocation-free in steady state:
  the interpolator reuses its output map + a per-id entity pool + a scratch index
  map, and `syncEntities` reuses a feet-position scratch — so GC hitches don't show
  up as periodic micro-stutter in the p95 graph.

### Snapshot broadcast rate (t8f) — **recommendation: keep `SNAPSHOT_RATE = 15`**

The broadcast cadence is `tick % SNAPSHOT_TICK_INTERVAL === 0` with
`SNAPSHOT_TICK_INTERVAL = TICK_RATE / SNAPSHOT_RATE`, which **must be an integer**.
With the fixed 30 Hz `TICK_RATE`, the only attainable rates are the integer divisors
of 30 — so the plan's "~15–20 Hz" really means **15 (every 2nd tick) or 30 (every
tick)**; 20 Hz would give a non-integral interval of 1.5 and is not reachable
without moving the sim tick.

Going to 30 Hz roughly **doubles snapshot bandwidth**. With the client fixes above
(t8a/t8b prediction for your own body, t8d adaptive interp + extrapolation for
everyone else) already covering the ~`SNAPSHOT_MS` (≈ 66.7 ms) gap, and M7's binary +
delta snapshots keeping a typical frame to ~57 B, that extra bandwidth buys only a
marginal, hard-to-perceive smoothness gain. **15 Hz stays the shipping value** and
comfortably holds the M7 bandwidth targets; **30 Hz is the one integral step up** if
a future change ever needs it. Because `INTERP_DELAY_MIN_MS` is expressed relative to
`SNAPSHOT_MS`, the t8d interpolation band keeps straddling snapshots automatically at
either rate.


## M9 notes (Phase 2 — World & Environment)

Milestone **M9** grows the flat building grid into a believable place: trees, a
lake, and roads. Task **t9a** (this section's prerequisite) lands only the shared
data model + collision so the rest of M9 can build on one source of truth.

### Shared World model & collision (t9a)

- **New `World` fields:** `trees: Tree[]` (circular colliders — `x`, `z`,
  `radius`, `height`), `water: Lake | null` (a circular `cx`/`cz`/`radius`
  region), `waterMode: WaterMode` (`'blocked'` for M9), and `roads: Road[]`
  (non-colliding polylines with a `width`).
- **Determinism.** Features are drawn from a second, seed-derived PRNG
  (`seed ^ 0x9e3779b9`) so the existing building layout for any seed is
  untouched; the only building change is that any box now sitting under the lake
  is dropped. Same seed ⇒ identical `trees`/`water`/`roads` on every client and
  the server (verified across seeds).
- **Collision.** `collideCircleXZ` now also pushes the body out of every tree and
  (because `waterMode === 'blocked'`) out of the lake shoreline via
  `resolveCircleCircle`, inside the same relaxation loop as buildings and before
  the perimeter clamp — so a player can never walk through a tree or into open
  water.
- **Baseline generation (t9a).** t9a emitted a *sparse* boundary forest, one lake
  on a ring that clears the plaza, and the interior street grid — the seams the
  rest of M9 builds on.

### World generation — districts, forest, roads, lake (t9b–t9d)

The shared generator now produces a town that reads as a place, still purely from
the seed and still byte-for-byte identical on client and server:

- **Districts (t9b).** Building footprint + height are graded by a block's
  Chebyshev distance from the core: a **tower core** (16–44 m) rings the plaza and
  **small houses** (3.5–8 m, smaller footprints) sit on the outskirts. The
  per-cell PRNG draw order is unchanged, so the placement stream stays aligned;
  only the height/footprint mapping changed. `footScale ≤ 1`, so the street-
  clearance and non-overlap invariants still hold.
- **Ring road (t9b).** `generateRoads` adds a closed loop at ±`TOWN_HALF` that
  ties the interior lanes together and fronts the forest (still non-colliding).
- **Dense perimeter forest (t9c).** `generateTrees` now packs a thick band of
  solid trees in the square annulus just outside the ring road out to the wall
  clamp (grid-stepped with per-tree jitter; ~740 trees/seed). At this spacing +
  trunk radius the band is walk-through-proof — a body marched at any edge/corner
  is stopped by trees before the wall clamp — so the edge reads as forest, not a
  slab (the clamp survives as an invisible backstop). The **NPC spawn corner**
  (`half − 5`) is left an open clearing so patient-zero never wakes wedged in the
  trees. Verified by `scripts/verify-world.mjs`.
- **Lake (t9d).** Radius widened to 8–12 m on a 28–38 m ring; still clears the
  plaza (ring − radius ≥ 16 > 12), stays inside the town, never reaches the forest
  band, and the road grid routes around it.

### Client rendering — instanced environment + lake (t9d/t9e)

- **Instanced forest (t9e).** `client/src/scene/Environment.ts` draws the whole
  ~740-tree forest as **two** `InstancedMesh`es (one trunk cylinder, one foliage
  cone), the road grid as **one** merged flat ribbon geometry, and rocks/bushes as
  **two** more instanced meshes — so the entire natural world is ~5 extra draw
  calls regardless of density. Scatter placement is deterministic from `world.seed`
  (a local `mulberry32` copy, never `Math.random`) and rejection-sampled clear of
  the plaza, buildings, lake, and roads.
- **Bare walls dropped (t9c).** `TownView.buildTown` no longer renders the four
  perimeter wall slabs — the forest now walls the edge. Collision is unchanged
  (the wall is a shared clamp, never a mesh).
- **Lake surface (t9d).** `client/src/scene/Water.ts` renders `world.water` as one
  dark, semi-metallic disc whose ripples come from a seamlessly-tiling procedural
  normal map scrolled each frame (a couple of scalar writes, zero per-frame
  allocations). Wired into `main.ts` beside `buildTown`/`addStreetLights`, animated
  in the render loop, and disposed on teardown.

### Server AI — trees + lake perception (t9f)

- **Nav grid.** `NavGrid` now also blocks cells within `NAV_CLEARANCE` of any tree
  and (when water is `blocked`) the lake, via a *scatter* pass — each disc marks
  only the cells inside its own footprint — so the natural obstacles cost a handful
  of cells apiece rather than an O(cells) rescan. A* routes around forest + water.
- **Steering.** The avoidance probe clearance is now `MIN(building, nearest tree,
  lake)` per candidate heading (a server-local ray-vs-circle inflated by the body
  radius, bound-culled), so the NPC steers around trunks and the shoreline.
- **Line of sight.** A server-local `hasSight` = shared building LoS **AND** no
  tree straddles the segment. Trees occlude sight; the **lake does not** (open
  water is see-through). Used at both perception sites (`isVisible` + the `follow`
  clear-line check). The forest is a perimeter annulus with an NPC-spawn clearing,
  so it never fragments the open interior — no new A* wedging.


## M14 notes (Phase 2 — VFX & Post-Processing)

Milestone **M14** adds the missing **game-feel / VFX layer** on top of the
M8–M13 base. It is deliberately **client-only**: no protocol, server, or
gameplay-balance change. Every effect is driven off the existing per-frame
render loop and the server event stream (`attack` / `stun` / `infect` /
`roundStart` / `roundEnd`, plus the `jump` movement-state edge), and each piece
is toggleable or degradable so it never gates the simulation. Four disjoint
modules land the work; `main.ts` wires them together (t14e).

### Post-processing pipeline (t14a)

- **`client/src/scene/PostFx.ts`** wraps three's `EffectComposer`:
  `RenderPass → UnrealBloomPass → HorrorPass (custom `ShaderPass`) → OutputPass`.
  The single frame call in `animate` swaps `renderer.render(scene, camera)` for
  `postFx.render(dtMs)`.
- **M11 color pipeline preserved.** The renderer's `ACESFilmicToneMapping` +
  `SRGBColorSpace` are left untouched. `RenderPass` draws into an offscreen
  **linear** buffer (three only tone-maps/encodes when writing to the *canvas*),
  the bloom + horror grade operate in linear, and **`OutputPass` applies the ACES
  curve + sRGB encode exactly once** at the end. No double tone-map.
- **Bloom** uses a high threshold (`~0.85`, strength `0.6`, radius `0.4`) so only
  bright emissive — the moon disc, lamp bulbs, lit windows, and the combat VFX —
  blooms, not the whole dim town.
- **HorrorPass** is one custom shader doing a radial **vignette**, subtle animated
  **film grain** (a `time` uniform advanced by `dtMs`), and a slight
  **desaturation** for a cold night mood.
- **`P`** toggles the whole chain (`postFx.enabled`) for an A/B / perf comparison,
  mirroring the backtick perf overlay; when off, `render()` falls back to a bare
  `renderer.render`. Allocation-free per frame; DPR- and resize-aware.

### Pooled particle system (t14b)

- **`client/src/scene/Particles.ts`** renders as **one** `THREE.Points`
  (additive, soft round sprite, `depthWrite:false`) backed by preallocated typed
  arrays + a packed live-count with swap-remove reaping — `MAX_PARTICLES = 512`,
  **zero steady-state allocation**. Fade is encoded by dimming the per-vertex
  color toward black (additive blend ⇒ dim reads as fade-out).
- Emitters: **`sparks`** (warm bat-impact debris, from `stun`), **`spores`**
  (sickly-green infection burst, from `infect`), and **`dust`** (available for
  footsteps/landing).

### Camera game-feel (t14c)

- **`client/src/scene/CameraShake.ts`** applies a **non-accumulating** offset
  *after* `FollowCamera.update` (which fully rewrites the camera transform each
  frame, so the offset is wiped next frame — never drifts). Trauma model
  (`shake = trauma²`), a decaying **FOV kick**, and a **landing punch**.
- Smooth shake noise comes from layered `Math.sin` with fixed per-axis
  frequencies/phases — **no `Math.random`**, allocation-free. It touches only the
  presentation `dtMs`, never the fixed sim/prediction `dt` (so t8a is unaffected).
- Triggers: your own swing → small FOV kick; a bat hit → sparks + a punch that is
  hardest when *you* landed/took it and otherwise falls off with distance
  (`traumaByProximity`); being infected → a hard jolt; round start/end horns → a
  light jolt; the local player touching down from a jump → a landing punch.

### Screen-space feedback (t14d)

- **`client/src/ui/ScreenFx.ts`** is a DOM overlay (fixed, `pointer-events:none`,
  animated via `opacity` only, dark-horror palette matching the HUD) with three
  layers: an **infection** flash (green, ~1.2 s, on being turned), a **damage**
  flash (red, optionally directional), and a persistent **danger** vignette whose
  intensity `main.ts` drives every frame from `dangerIntensity` — a rising 0..1
  ramp as the nearest zombie closes on a **human** local player
  (`DANGER_FAR_M = 12` → `DANGER_NEAR_M = 3`), with a gentle breath pulse.

All four systems are constructed once after the renderer/scene/camera, advanced
in the frame loop, and disposed on `beforeunload`. `pnpm typecheck` + `pnpm
build` stay green; the bundle grows ~30 KB (gzip) from the postprocessing addons.


## M15 notes (Phase 2 — HUD & UX Polish)

Milestone **M15** adds the missing **HUD & UX layer** over the M8–M14 base. Like
M14 it is deliberately **client-only**: no protocol, server, or gameplay-balance
change. Four disjoint modules land the work and `main.ts` wires them together
(t15e), each reading only existing client state (the interpolated entity set, the
seeded `World`, the `ROUND` message, and the local look/lock state).

### Radar minimap (t15a)

- **`client/src/ui/Minimap.ts`** is a top-right, dpr-crisp `<canvas>` overlay
  (click-through, dark/rounded/blurred to match the HUD). Each frame it draws a
  **player-centered, north-up radar** (`RADAR_RANGE_M = 44`, world +Z drawn
  downward, circular clip): the lake disc, roads, and building footprints from the
  `World`, then entity blips — **green** humans, **red** zombies — with the local
  player a bright wedge pointing along the look yaw and an amber north tick.
- Range-culls everything outside the radar disc and iterates the entity/building
  lists in place, so it stays cheap; before the world/local body exist it draws a
  faint "no signal" dish instead of throwing. Visibility follows the `minimap`
  preference (below) and the `N` shortcut; hidden ⇒ `update` is a no-op.

### Scoreboard / roster (t15b)

- **`client/src/ui/Scoreboard.ts`** is a centered, click-through modal shown while
  **`Tab` is held**. A header summarizes the round (`humans N · infected N · mm:ss
  | phase`, degrading to `—` before the first `ROUND`), and the body lists every
  entity — **humans first, then id** — with a team dot, `#id`, a `you` highlight on
  the local row, the team, and a status derived from the movement `state`
  (`down` → downed, `stun` → stunned, `crawl` → crawling, …). The shell is built
  once; rows are rebuilt (`replaceChildren`) only while the board is visible.

### Settings / options menu + persisted preferences (t15c)

- **`client/src/ui/Settings.ts`** is a tiny **localStorage-backed** preference
  store (key `tcd.settings.v1`) that is **offline-safe** (all storage access is
  `try/catch`, degrading to in-memory). Keys + defaults: `postProcessing` (`true`),
  `minimap` (`true`), `mouseSensitivity` (`0.0022`, clamped to `0.0005..0.01`), and
  `renderQuality` (`'high'`). `set` persists the whole state and notifies
  subscribers **only on a real change**.
- **`client/src/ui/SettingsMenu.ts`** is a centered, **interactive**
  (`pointer-events:auto`) modal toggled with `O` (and `Esc`-to-close), whose
  controls two-way bind to the store: a post-processing toggle, a minimap toggle, a
  sensitivity slider, and a low/medium/high quality selector.
- `main.ts` **applies** each preference to the real systems in `applySetting`
  (once at startup, then on every change): `postFx.enabled`,
  `controls.setSensitivity` (new `Controls` hook), and — for quality — a
  device-pixel-ratio cap (`low 1 · medium 1.5 · high 2`) via
  `renderer.setPixelRatio` kept in lock-step with `postFx.setSize`. The `P` and
  `N` shortcuts write **through** the store so the menu always agrees.

### Combat reticle + objective banner (t15d)

- **`client/src/ui/Reticle.ts`** draws a center crosshair (an inline SVG mutated
  by attribute/opacity only — zero node churn) that **empties/reddens on a swing**
  and sweeps its recharge arc closed back to ready-green over `ATTACK_COOLDOWN_MS`
  (fed by `reticle.onSwing()` at the local attack), plus a bottom-center
  **objective** line driven by phase + team (`Survive M:SS` for humans, "Infect the
  survivors" for zombies, lobby/countdown/ended copy otherwise). The crosshair
  shows only while pointer-locked and actually playing.

Each module is constructed once after the renderer/scene/camera, advanced in the
frame loop (a no-op while hidden), and disposed on `beforeunload`; the new
shortcuts (`O` options · `Tab` scores · `N` map) are also surfaced in the HUD's
controls hint. `pnpm typecheck` + `pnpm build` stay green.

---

## M16 notes (Phase 2 — Menus & Onboarding)

Phase 2 continuation. A **client-side onboarding & menus** batch on top of the
M8–M15 base — a front door, a controls reference, a real `Esc` menu, and the
kill/turn feed lifted into its own module. Pure client-side UX polish: **no
protocol, server, or gameplay-balance changes**, and everything matches the
existing dark / translucent / monospace / blurred idiom shared by the HUD,
`AudioControls`, `Scoreboard`, and `SettingsMenu`. Overlays layer by `zIndex`:
title `50` > pause `49` > help `48` > settings `20` > reticle `11` > screen-fx `10`.

### Title / start screen (t16a)

- **`client/src/ui/TitleScreen.ts`** is a full-viewport, **interactive**
  (`pointer-events:auto`) overlay shown on first load that gates entry: the game
  title, a one-line premise, a **Play** button, and a controls hint. `Play` (or
  `Enter`/`Space`) hides it and fires `onPlay`. `main.ts` wires `onPlay` to the
  first-gesture audio unlock (`resume` + `startAmbient` + `startMusic`) and a
  `renderer.domElement.requestPointerLock()` so Play drops straight into mouse-look.

### Controls / help reference overlay (t16b)

- **`client/src/ui/keybindings.ts`** is a pure, zero-DOM **single source of truth**:
  a typed `KEYBINDINGS` list grouped Movement / Combat / Interface, verified against
  `Controls.ts` + `main.ts` (WASD move · `Shift` run · `C` crawl · `Space` jump ·
  LMB swing · `R` ready · `Tab` scores · `O` options · `N` map · `P` post-fx ·
  `M` mute · `` ` `` perf · `H`/`?` controls · `Esc` menu).
- **`client/src/ui/HelpOverlay.ts`** renders that list as a centered modal card
  (bordered key chips + action rows). Toggled with `H` (or `?`); closes on
  `Esc`/`H`/`?`. Wired into the same window-level UX-shortcut handler as `O`/`N`.

### Esc pause menu (t16c)

- **`client/src/ui/PauseMenu.ts`** is a centered modal with **Resume / Controls /
  Settings** buttons, kept **callback-driven** (it imports no other UI/system
  module). `main.ts` supplies the behavior: Resume re-requests pointer lock,
  Controls opens the help overlay, and Settings closes the pause panel then opens
  the options modal (so the lower-`zIndex` settings modal isn't hidden behind it).
- The trigger is a `main.ts` **`pointerlockchange`** hook: the browser drops
  pointer lock on `Esc` (or tab-blur), and a mid-play exit — title dismissed, no
  panel already up — opens the pause menu; re-acquiring the lock (Play/Resume)
  closes it. This turns the previously-silent `Esc` into a real in-game menu.

### Kill / turn feed module (t16d)

- **`client/src/ui/KillFeed.ts`** extracts the feed that used to be inlined in
  `main.ts` into a self-contained module with the **same semantics**
  (`FEED_TTL_MS = 6000`, `FEED_MAX_LINES = 5`, newest-on-top, per-line
  `min(1, ttl/1000)` fade, hidden when empty), plus polish: a left accent bar, a
  one-shot fade/slide-in on push (WAAPI, guarded), and cached per-line nodes so a
  steady feed does zero DOM writes. `main.ts` feeds it the same pre-formatted
  strings via `killFeed.push(...)` and ages it with `killFeed.update(dt)`.

All four modules construct once after the renderer/scene/camera, update as no-ops
while hidden, and are disposed on `beforeunload`; the HUD look-hint now advertises
`Esc: menu · H: controls`. `pnpm typecheck` + `pnpm build` stay green.
