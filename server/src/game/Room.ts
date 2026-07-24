import { WebSocket } from 'ws';
import {
  MessageType,
  InputKey,
  hasKey,
  encode,
  decodeClientMessage,
  TICK_RATE,
  TICK_MS,
  SNAPSHOT_TICK_INTERVAL,
  MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  NPC_CHASE_SPEED,
  NPC_WANDER_SPEED,
  NPC_ATTACK_RANGE,
  PLAYER_RADIUS,
  ATTACK_COOLDOWN_MS,
  BAT_RANGE,
  BAT_ARC_DEG,
  STUN_DURATION_MS,
  BAT_KNOCKBACK,
  INFECTION_CONTACT_RADIUS,
  RESPAWN_DELAY_MS,
  STAMINA_MAX,
  STAMINA_DRAIN_PER_SEC,
  STAMINA_REGEN_PER_SEC,
  STAMINA_MIN_TO_SPRINT,
  SNAPSHOT_WIRE,
  encodeSnapshotBinary,
  diffSnapshots,
  generateWorld,
  collideCircleXZ,
  createMoveState,
  step,
  type World,
  type EntityKind,
  type EntitySnapshot,
  type EntityState,
  type GameEvent,
  type WelcomeMessage,
  type SnapshotMessage,
  type DeltaSnapshot,
  type RoundMessage,
  type PongMessage,
  type WireData,
} from '@crawling-dark/shared';
import { Player } from './Player';
import { Round } from './Round';
import { ZombieAI, forwardFromYaw, type ZombieIntent } from './ai';
import { cullByInterest } from './interest';

/**
 * The single game room for The Crawling Dark (M3 · t3a/t3b/t3c).
 *
 * Responsibilities:
 *  - Registry: assign a distinct, monotonically increasing `playerId` per
 *    connection, spawn each player spread around the origin, cap the active
 *    roster at {@link MAX_PLAYERS} (spillover spectates), and clean up on close.
 *  - Simulation: a drift-resistant, fixed-timestep loop at {@link TICK_RATE} Hz
 *    that advances each player's authoritative {@link MoveState} via the shared,
 *    deterministic {@link step}, resolves circle-vs-AABB collision against the
 *    seeded {@link World}, then resolves combat (bat swings, infections) and the
 *    down->respawn-as-zombie lifecycle in the DESIGN §5 order.
 *  - Snapshots: every {@link SNAPSHOT_TICK_INTERVAL} ticks, broadcast one base
 *    snapshot (with any buffered gameplay events) to all sockets plus a
 *    lightweight {@link RoundMessage} carrying live team counts for the HUD.
 *
 * Combat model (see DESIGN §1/§5): a HUMAN's ATTACK is a bat swing — a cone hit
 * that knocks back and stuns zombies (never removes them, no friendly fire). A
 * ZOMBIE's ATTACK is a claw that opens a short window during which a human in
 * contact range is infected (downed), then respawns on the zombie team.
 */

/** Fixed map seed for the town; the client rebuilds the identical world from it. */
const MAP_SEED = 1;

/** Radius of the spawn ring around the origin, in meters. */
const SPAWN_RING_RADIUS = 4;

/** Golden angle (radians) used to spread successive spawns around the ring. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Fixed simulation delta in seconds (one tick). */
const DT = TICK_MS / 1000;

/**
 * Maximum fixed steps advanced per timer wake. Caps catch-up work so a stalled
 * process (GC pause, debugger) cannot trigger a spiral of death.
 */
const MAX_CATCHUP_STEPS = 5;

/**
 * How long (ms) an accepted ATTACK keeps its "window" open. This is a
 * server-local combat tunable (no shared constant exists): it drives the brief
 * `attack` animation state for a swing/claw, and for a zombie it is the live
 * contact-infection window. Kept short so a claw is a deliberate contact hit
 * rather than a lingering aura; a few ticks at 30 Hz.
 */
const ATTACK_WINDOW_MS = 300;

/**
 * Per-tick multiplicative decay applied to a zombie's bat knockback velocity.
 * The shared {@link MoveState} carries no horizontal momentum, so knockback is
 * an impulse we integrate and bleed off here: at 0.8/tick (~30 Hz) an 8 m/s
 * shove is spent within roughly the first half of the 1.5 s stun.
 */
const KNOCKBACK_DECAY_PER_TICK = 0.8;

/** Knockback speed (m/s) below which we snap to exactly zero, so it settles cleanly. */
const KNOCKBACK_EPSILON = 0.05;

/**
 * Cosine of the bat cone's half-angle. Precomputed once from {@link BAT_ARC_DEG}
 * so the per-target hit test is a single dot-product comparison (a direction is
 * "in front" iff its dot with the facing is >= this).
 */
const BAT_HALF_ARC_COS = Math.cos((BAT_ARC_DEG / 2) * (Math.PI / 180));

export class Room {
  /** All connected clients (active players and spectators), keyed by id. */
  private readonly players = new Map<number, Player>();

  /**
   * The seeded town, generated ONCE from {@link MAP_SEED}. The identical seed is
   * sent in WELCOME so every client rebuilds byte-for-byte the same geometry;
   * the server collides players against this world's AABB footprints.
   */
  private readonly world: World = generateWorld(MAP_SEED);

  /**
   * Reactive steering brain for the NPC patient-zero zombie (M4 · t4a), built
   * over the same seeded {@link world} it navigates and collides against.
   *
   * MUTABLE by design (M5): the AI keeps a private per-NPC memory map keyed by
   * entity id (targets, line-of-sight grace). On every return to the lobby the
   * NPC is removed and a fresh brain is assigned here, which is the cleanest way
   * to drop that stale memory without reaching into `ai.ts`.
   */
  private zombieAI = new ZombieAI(this.world);

  /**
   * Authoritative round lifecycle (M5 · t5a): a thin {@link Round} value object
   * owning the phase, its countdown timer, and the winner. The Room drives it
   * from {@link step} by reading live counts each tick — spawning/removing the
   * NPC, resetting players, and buffering round events as the phase changes —
   * so the machine stays a pure timekeeper and the Room owns all side effects.
   */
  private readonly round = new Round();

  /** Next id to hand out. Only ever increments, so ids are never reused. */
  private nextPlayerId = 1;

  /** Authoritative simulation tick counter, incremented once per fixed step. */
  private tick = 0;

  /** Timer handle for the fixed-timestep pump. */
  private loop: ReturnType<typeof setInterval> | null = null;

  /** Real-time clock (ms) at the previous pump, via {@link performance.now}. */
  private lastTime = 0;

  /** Unspent real time (ms) carried between pumps for drift-free stepping. */
  private accumulator = 0;

  /**
   * Gameplay events buffered as they occur during ticks (attack/stun/infect),
   * flushed into the NEXT broadcast snapshot and then cleared. Buffering rather
   * than sending inline keeps events aligned with the snapshot cadence.
   */
  private readonly events: GameEvent[] = [];

  /* ------------------------------------------------------------------------ */
  /* Registry / lifecycle                                                     */
  /* ------------------------------------------------------------------------ */

  /** Number of sockets currently connected (players + spectators). */
  get size(): number {
    return this.players.size;
  }

  /** Count of active (non-spectator, non-NPC) players currently simulated. */
  private activeCount(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (!p.spectator && !p.isNpc) n++;
    }
    return n;
  }

  /**
   * Count of active players who have readied up (t5b). Spectators and NPCs can
   * never be ready, so this is always ≤ {@link activeCount}; the round machine
   * starts the countdown once it reaches {@link MIN_PLAYERS_TO_START}.
   */
  private readyCount(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.spectator || p.isNpc) continue;
      if (p.ready) n++;
    }
    return n;
  }

  /**
   * Count of humans still standing (t5c): active players on team `'human'` that
   * are not downed. This is the live figure the win/lose evaluation reads each
   * active tick — 0 means everyone has been turned (zombies win), ≥1 at the
   * clock's expiry means the humans survived.
   */
  private humansAliveCount(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.spectator || p.isNpc) continue;
      if (p.team === 'human' && !p.down) n++;
    }
    return n;
  }

  /**
   * The fixed spawn-ring slot for a player id — a deterministic golden-angle
   * placement around the origin so successive spawns fan out instead of
   * stacking. Shared by {@link join} (first placement) and {@link resetPlayers}
   * (respawn on a fresh round) so the two never drift apart.
   */
  private spawnPoint(id: number): { x: number; z: number } {
    const angle = id * GOLDEN_ANGLE;
    return { x: Math.cos(angle) * SPAWN_RING_RADIUS, z: Math.sin(angle) * SPAWN_RING_RADIUS };
  }

  /**
   * Register a freshly connected socket: assign a distinct id, decide whether
   * it is a spectator (roster already at {@link MAX_PLAYERS}), place it on the
   * spawn ring, store it, and send the one-shot {@link WelcomeMessage}.
   */
  join(socket: WebSocket): Player {
    const id = this.nextPlayerId++;
    const spectator = this.activeCount() >= MAX_PLAYERS;

    // Spread spawns around a small ring so overlapping tabs don't stack; a
    // spectator has no entity, so it sits at the origin.
    const spawn = spectator ? { x: 0, z: 0 } : this.spawnPoint(id);

    const player = new Player(id, socket, spectator, spawn.x, spawn.z);
    this.players.set(id, player);

    const welcome: WelcomeMessage = {
      t: MessageType.Welcome,
      playerId: id,
      tickRate: TICK_RATE,
      mapSeed: MAP_SEED,
    };
    this.send(player, welcome);

    return player;
  }

  /** Remove a player from the room so it disappears from future snapshots. */
  remove(player: Player): void {
    this.players.delete(player.id);
  }

  /* ------------------------------------------------------------------------ */
  /* Ingress                                                                  */
  /* ------------------------------------------------------------------------ */

  /**
   * Decode and dispatch one client frame. Unknown or not-yet-implemented
   * messages (READY) are ignored; they land in later milestones.
   */
  handleMessage(player: Player, data: WireData): void {
    const msg = decodeClientMessage(data);
    if (msg === null) return;

    switch (msg.t) {
      case MessageType.Join:
        // Store the display name; identity for scoreboards/HUD.
        player.name = msg.name;
        break;

      case MessageType.Input:
        // t1e: record the latest input; movement is applied by the tick loop.
        player.input = { keys: msg.keys, yaw: msg.yaw };
        player.lastSeq = Math.max(player.lastSeq, msg.seq);
        // t7b: capture the snapshot the client has confirmed applying. Advance
        // the confirmed baseline monotonically so a late/reordered ack can
        // never roll it backwards; sendSnapshotTo delta-encodes against it.
        if (msg.snapAck !== undefined) {
          player.lastSnapAck =
            player.lastSnapAck === undefined
              ? msg.snapAck
              : Math.max(player.lastSnapAck, msg.snapAck);
        }
        break;

      case MessageType.Attack:
        // t3a/t3b: accept a bat swing (human) or claw (zombie). Reject it for
        // spectators, the downed, or the stunned, and while the cooldown is
        // still running. Otherwise latch it to resolve on the next fixed step
        // (DESIGN §5, steps 4-5) and start the cooldown so it can't be spammed.
        if (player.spectator || player.down || player.isStunned) break;
        if (player.attackCooldownMs > 0) break;
        player.pendingAttack = true;
        player.attackCooldownMs = ATTACK_COOLDOWN_MS;
        break;

      case MessageType.Ready:
        // t5b: record the lobby ready toggle. Spectators and NPCs have no say
        // (they can't ready up), so ignore it for them. We deliberately do NOT
        // start the countdown here — the round state machine polls readiness
        // every tick, keeping a single source of truth for when a round begins.
        if (!player.spectator && !player.isNpc) player.ready = msg.ready;
        break;

      case MessageType.Ping: {
        // t1e: echo the probe id straight back so the client can time RTT.
        const pong: PongMessage = { t: MessageType.Pong, id: msg.id };
        this.send(player, pong);
        break;
      }

      default:
        // Unknown / server-only message tags are ignored.
        break;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Simulation loop (t1c)                                                    */
  /* ------------------------------------------------------------------------ */

  /** Start the fixed-timestep pump. Idempotent. */
  start(): void {
    if (this.loop !== null) return;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.loop = setInterval(() => this.pump(), TICK_MS);
  }

  /** Stop the pump (used for clean shutdown / tests). */
  stop(): void {
    if (this.loop !== null) {
      clearInterval(this.loop);
      this.loop = null;
    }
  }

  /**
   * Timer wake: accumulate the real elapsed time and advance the simulation in
   * fixed {@link DT} increments, capping catch-up so a long stall can't spiral.
   */
  private pump(): void {
    const now = performance.now();
    this.accumulator += now - this.lastTime;
    this.lastTime = now;

    let steps = 0;
    while (this.accumulator >= TICK_MS && steps < MAX_CATCHUP_STEPS) {
      this.step();
      this.accumulator -= TICK_MS;
      steps++;
    }

    // Hit the cap with time still owed: drop the backlog rather than chase it.
    if (steps === MAX_CATCHUP_STEPS && this.accumulator > TICK_MS) {
      this.accumulator = 0;
    }
  }

  /**
   * Advance exactly one fixed tick, in the DESIGN §5 pipeline order:
   *  - step 2: integrate each active player's movement (honoring stun/down) —
   *    ALWAYS, in every phase, so the lobby and countdown stay walkable;
   *  - steps 3-5 (ONLY while the round is `active`): advance the NPC zombie AI
   *    (seek + avoid + contact attack), resolve bat swings (cone hit -> stun +
   *    knockback), resolve infections (open zombie window -> down human), then
   *    flip any elapsed death-cams onto the zombie team;
   *  - step 6: drive the round state machine (t5a/t5b/t5c) — poll readiness,
   *    tick the phase clock, evaluate win/lose, and perform the phase side
   *    effects (spawn/remove the NPC, reset players, buffer round events);
   *  - every ~2nd tick, broadcast a snapshot + the real ROUND message.
   *
   * The AI/combat block is gated to the `active` phase so nothing hunts or
   * fights in the lobby, countdown, or results screen. It runs BEFORE the round
   * update so the win/lose check reads the freshly-resolved live human count
   * (e.g. a last human downed this very tick already reads as turned).
   */
  private step(): void {
    // Step 2 — integrate the human-controlled players from their inputs. This
    // runs in every phase so players can mill about the lobby / countdown.
    for (const p of this.players.values()) {
      if (p.spectator || p.isNpc) continue;
      this.integrate(p);
    }

    // Steps 3-5 — the AI + combat/infection pipeline, live only during a round.
    if (this.round.phase === 'active') {
      this.updateNpcs();
      this.resolveAttacks();
      this.resolveInfections();
      this.resolveRespawns();
    }

    // Step 6 — advance the round lifecycle after this tick's world is settled.
    this.updateRound();

    this.tick++;

    if (this.tick % SNAPSHOT_TICK_INTERVAL === 0) {
      this.broadcastSnapshot();
    }
  }

  /**
   * Integrate one player's authoritative state for a single fixed tick.
   *
   * Pipeline (DESIGN §5, step 2): tick the combat timers down, then advance
   * movement subject to the player's condition:
   *  - DOWN: frozen for the death-cam — no input, gravity, or knockback slide.
   *  - STUNNED: movement input is suppressed (cannot walk), but the player still
   *    falls and still slides under any active bat knockback.
   *  - NORMAL: full yaw-relative movement from {@link step}.
   * In the moving cases the horizontal knockback impulse (which the shared
   * {@link MoveState} can't carry) is applied and decayed, then X/Z are resolved
   * against the town via {@link collideCircleXZ}. Y is left exactly as the sim
   * produced it.
   */
  private integrate(p: Player): void {
    this.advanceTimers(p);

    // A downed player is frozen in place for its death-cam.
    if (p.down) return;

    // Stunned players can't walk (input suppressed) but still fall and slide.
    const rawKeys = p.isStunned ? 0 : p.input.keys;

    // Advance sprint stamina and resolve exhaustion gating BEFORE stepping, so
    // an out-of-stamina player is masked down to walk speed on this very tick.
    // Returns the (possibly Run-masked) keys the shared `step` should see.
    const keys = this.updateStamina(p, rawKeys);

    const next = step(p.move, { keys, yaw: p.input.yaw }, DT);

    // Apply then decay the horizontal knockback impulse (see Player.kvx/kvz).
    const px = next.x + p.kvx * DT;
    const pz = next.z + p.kvz * DT;
    p.kvx = decayKnockback(p.kvx);
    p.kvz = decayKnockback(p.kvz);

    const resolved = collideCircleXZ(this.world, px, pz, PLAYER_RADIUS);
    p.move = { ...next, x: resolved.x, z: resolved.z };
  }

  /** Tick every millisecond countdown timer on a player down by one fixed step. */
  private advanceTimers(p: Player): void {
    if (p.attackCooldownMs > 0) p.attackCooldownMs = Math.max(0, p.attackCooldownMs - TICK_MS);
    if (p.stunMs > 0) p.stunMs = Math.max(0, p.stunMs - TICK_MS);
    if (p.attackWindowMs > 0) p.attackWindowMs = Math.max(0, p.attackWindowMs - TICK_MS);
    if (p.down && p.respawnMs > 0) p.respawnMs = Math.max(0, p.respawnMs - TICK_MS);
  }

  /**
   * Advance one player's sprint stamina for a single fixed tick and return the
   * key bitmask the shared {@link step} should actually consume this tick (t6b).
   *
   * A player is *actually sprinting* only when EVERY condition holds: the Run bit
   * is held, at least one direction key is held (holding Run while standing still
   * costs nothing), they are not crawling (crawl already caps speed and beats Run
   * in {@link moveSpeed}), they are grounded (no air-sprint), and they are not
   * currently exhausted. Sprinting drains at {@link STAMINA_DRAIN_PER_SEC};
   * everything else regenerates at {@link STAMINA_REGEN_PER_SEC}, both clamped to
   * `[0, STAMINA_MAX]`.
   *
   * Exhaustion is a hysteresis latch: it arms the instant stamina reaches 0 and
   * clears only once stamina has climbed back to {@link STAMINA_MIN_TO_SPRINT},
   * so a spent runner stays pinned to walk speed until it has recovered a real
   * buffer. While the latch is armed the Run bit is masked OUT of the returned
   * keys, which makes {@link step} run at walk speed WITHOUT any change to
   * `sim.ts` (the shared kinematics stay untouched — the gating lives here).
   *
   * Prediction note: the M6 t6a client prediction (a separate branch) runs the
   * raw {@link step} with the UNMASKED keys, so at the exact instant of
   * exhaustion the predicted position can momentarily overshoot the server's
   * walk-speed result. Snapshot reconciliation corrects that within a frame or
   * two; smoothing that single-tick blip is intentionally out of scope here.
   */
  private updateStamina(p: Player, keys: number): number {
    // Mirror step()'s crawl latch so we agree on whether the player is crawling
    // THIS tick: crawl mode only (re)evaluates while grounded, and a crawler is
    // capped at crawl speed and can never sprint regardless of the Run bit.
    const crawling = p.move.grounded ? hasKey(keys, InputKey.Crawl) : p.move.crawling;

    const moving =
      hasKey(keys, InputKey.Forward) ||
      hasKey(keys, InputKey.Back) ||
      hasKey(keys, InputKey.Left) ||
      hasKey(keys, InputKey.Right);

    const sprinting =
      hasKey(keys, InputKey.Run) && moving && !crawling && p.move.grounded && !p.exhausted;

    if (sprinting) {
      p.stamina = Math.max(0, p.stamina - STAMINA_DRAIN_PER_SEC * DT);
      // Empty this tick → latch exhausted so the mask below (and the next few
      // ticks) pin the runner to walk speed until it recovers the buffer.
      if (p.stamina <= 0) p.exhausted = true;
    } else {
      p.stamina = Math.min(STAMINA_MAX, p.stamina + STAMINA_REGEN_PER_SEC * DT);
      if (p.exhausted && p.stamina >= STAMINA_MIN_TO_SPRINT) p.exhausted = false;
    }

    // While exhausted, strip Run so `step` moves at walk speed this tick.
    return p.exhausted ? keys & ~InputKey.Run : keys;
  }

  /* ------------------------------------------------------------------------ */
  /* Combat resolution (t3a/t3b/t3c)                                          */
  /* ------------------------------------------------------------------------ */

  /* ------------------------------------------------------------------------ */
  /* Round state machine (t5a/t5b/t5c)                                        */
  /* ------------------------------------------------------------------------ */

  /**
   * Drive the round lifecycle one fixed step. Dispatches on the current phase;
   * each handler reads live counts, ticks its clock, and requests the
   * transitions + side effects for that phase. Called once per {@link step}
   * with the fixed `dtMs = TICK_MS`, keeping the whole machine deterministic and
   * in lockstep with the simulation (no wall-clock timing anywhere).
   */
  private updateRound(): void {
    switch (this.round.phase) {
      case 'lobby':
        this.updateLobby();
        break;
      case 'countdown':
        this.updateCountdown();
        break;
      case 'active':
        this.updateActive();
        break;
      case 'ended':
        this.updateEnded();
        break;
    }
  }

  /**
   * LOBBY (t5b): idle until enough players have readied up. Start the countdown
   * once at least {@link MIN_PLAYERS_TO_START} active players are ready AND at
   * least that many are actually present. (Ready implies active, so the second
   * check is belt-and-braces, but it states the intent explicitly.)
   */
  private updateLobby(): void {
    if (this.activeCount() >= MIN_PLAYERS_TO_START && this.readyCount() >= MIN_PLAYERS_TO_START) {
      this.round.toCountdown();
    }
  }

  /**
   * COUNTDOWN (t5a): tick the pre-round clock down. If the active roster falls
   * below {@link MIN_PLAYERS_TO_START} before it expires (someone left), abandon
   * the countdown and fall back to a fresh lobby. When the clock reaches 0, the
   * round begins.
   */
  private updateCountdown(): void {
    if (this.activeCount() < MIN_PLAYERS_TO_START) {
      this.resetToLobby();
      return;
    }
    this.round.tick(TICK_MS);
    if (this.round.timeLeftMs <= 0) this.startRound();
  }

  /**
   * ACTIVE (t5a/t5c): tick the 5:00 survival clock, then evaluate win/lose on
   * the freshly-settled world (this runs after the combat block in {@link step},
   * so a human downed this very tick already counts as turned).
   *
   * Ordering encodes the DESIGN rules:
   *  - if the whole room emptied mid-round, there is no one to win — bail
   *    gracefully to the lobby rather than declaring a hollow victory;
   *  - ZOMBIES win the instant the live human count hits 0 (everyone turned).
   *    This cannot mis-fire on the first active tick: the round begins with all
   *    players human, and this handler only runs on ticks AFTER the countdown
   *    handler flipped us to `active`, so the count read here is never stale;
   *  - otherwise HUMANS win when the clock expires with at least one survivor.
   *    Zombie-win is checked first, so a simultaneous "last human turns as the
   *    clock hits 0" resolves as a zombie win, per spec.
   */
  private updateActive(): void {
    // Everyone disconnected: no round to adjudicate, just return to the lobby.
    if (this.activeCount() === 0) {
      this.resetToLobby();
      return;
    }

    this.round.tick(TICK_MS);

    const humansAlive = this.humansAliveCount();
    if (humansAlive === 0) {
      this.endRound('zombie');
    } else if (this.round.timeLeftMs <= 0) {
      this.endRound('human');
    }
  }

  /**
   * ENDED (t5a): hold on the results/scoreboard clock, then recycle the room
   * back to a clean lobby (reset players, drop the NPC) when it expires.
   */
  private updateEnded(): void {
    this.round.tick(TICK_MS);
    if (this.round.timeLeftMs <= 0) this.resetToLobby();
  }

  /**
   * Begin the active round: arm the survival clock, spawn the single NPC patient
   * zero out on the ring road (M4 · t4a; the horde grows only from turned
   * players thereafter), and buffer a one-off {@link 'roundStart'} event so
   * clients get a discrete "go" signal alongside the phase flip.
   */
  private startRound(): void {
    this.round.toActive();
    this.spawnNpcZombie();
    this.buffer({ kind: 'roundStart' });
  }

  /**
   * End the active round with a decided `winner`: move to the results phase and
   * buffer a one-off {@link 'roundEnd'} event so clients can play the sting /
   * show the scoreboard exactly once.
   */
  private endRound(winner: EntityKind): void {
    this.round.toEnded(winner);
    this.buffer({ kind: 'roundEnd' });
  }

  /**
   * Return to a clean lobby: flip the phase and wipe the world back to its
   * pre-round state (see {@link resetPlayers}). Used both when a round ends and
   * whenever a countdown/active game collapses because too few players remain.
   */
  private resetToLobby(): void {
    this.round.toLobby();
    this.resetPlayers();
  }

  /**
   * Wipe the world back to a fresh, pre-round state for a new lobby (t5a):
   *  - remove every NPC (the patient-zero zombie) from the room;
   *  - assign a brand-new {@link ZombieAI} so no stale per-NPC memory (targets,
   *    LOS grace) leaks across rounds — the AI keys its state map by entity id,
   *    and ids are never reused, so replacing the whole brain is the clean drop;
   *  - turn every active player back into a fresh HUMAN: reset team, clear all
   *    combat/infection state, un-ready them, and respawn them on their fixed
   *    golden-angle ring slot (a full new {@link MoveState}, so any jump/crawl/
   *    velocity is cleared too).
   * Spectators are left untouched — they carry no entity or combat state.
   */
  private resetPlayers(): void {
    // Drop the NPC(s) first so the loop below only touches real players.
    for (const p of this.players.values()) {
      if (p.isNpc) this.players.delete(p.id);
    }

    // Fresh AI brain → stale per-NPC memory from the last round is gone.
    this.zombieAI = new ZombieAI(this.world);

    for (const p of this.players.values()) {
      if (p.spectator) continue; // (NPCs already removed above)
      p.team = 'human';
      this.clearCombatState(p);
      p.ready = false;
      const spawn = this.spawnPoint(p.id);
      p.move = createMoveState({ x: spawn.x, z: spawn.z });
    }
  }

  /**
   * Spawn the lone NPC zombie on the ring road — well outside the central plaza
   * where humans spawn — on the zombie team, with a fresh id that never collides
   * with a player's. It joins the same {@link players} map as everyone else, so
   * snapshots, bat swings, and the infection loop all treat it uniformly; it
   * simply carries no socket and is steered by {@link ZombieAI}.
   */
  private spawnNpcZombie(): void {
    const id = this.nextPlayerId++;
    // A corner of the ring road: buildings never reach past ~51 m from centre and
    // the wall sits at ~half, so this is clear street. Collision-resolve once as a
    // belt-and-braces guard against any awkward placement.
    const edge = this.world.half - 5;
    const spawn = collideCircleXZ(this.world, edge, edge, PLAYER_RADIUS);

    const npc = new Player(id, null, false, spawn.x, spawn.z, true);
    npc.team = 'zombie';
    this.players.set(id, npc);
  }

  /**
   * Step 3 of the tick: drive every NPC zombie. For each, tick its combat timers,
   * gather the live human candidates, ask the {@link ZombieAI} where it wants to
   * go, move it there (collision-resolved like a player), and finally let it
   * decide whether to claw. Ordered after player integration so the NPC chases
   * up-to-date human positions.
   */
  private updateNpcs(): void {
    const humans = this.liveHumans();
    for (const npc of this.players.values()) {
      if (!npc.isNpc) continue;
      this.advanceTimers(npc);
      const intent = this.zombieAI.update(npc, humans, TICK_MS);
      this.integrateNpc(npc, intent);
      this.decideNpcAttack(npc, humans);
    }
  }

  /** Live, infectable humans (non-spectator, team 'human', not downed). */
  private liveHumans(): Player[] {
    const humans: Player[] = [];
    for (const p of this.players.values()) {
      if (p.spectator || p.isNpc) continue;
      if (p.team === 'human' && !p.down) humans.push(p);
    }
    return humans;
  }

  /**
   * Move one NPC for a tick per its {@link ZombieIntent}. It faces and advances
   * along the AI's steered heading at chase or patrol speed (zero while stunned,
   * so a bat hit still stops it), applies then decays any bat knockback exactly
   * like a player, and resolves circle-vs-AABB collision against the town. The
   * synthesized `input.keys` exist only so {@link deriveState} reports the right
   * walk/run/idle animation for the NPC in snapshots — the NPC never runs `step`.
   */
  private integrateNpc(npc: Player, intent: ZombieIntent): void {
    const moving = intent.moving && !npc.isStunned;
    const speed = moving ? (intent.running ? NPC_CHASE_SPEED : NPC_WANDER_SPEED) : 0;

    const f = forwardFromYaw(intent.desiredYaw);
    const px = npc.move.x + f.x * speed * DT + npc.kvx * DT;
    const pz = npc.move.z + f.z * speed * DT + npc.kvz * DT;
    npc.kvx = decayKnockback(npc.kvx);
    npc.kvz = decayKnockback(npc.kvz);

    const resolved = collideCircleXZ(this.world, px, pz, PLAYER_RADIUS);
    npc.move = {
      ...npc.move,
      x: resolved.x,
      z: resolved.z,
      y: 0,
      vy: 0,
      grounded: true,
      yaw: intent.desiredYaw,
    };

    // Reflect motion in the animation state (deriveState reads input.keys).
    npc.input = {
      keys: moving ? (intent.running ? InputKey.Forward | InputKey.Run : InputKey.Forward) : 0,
      yaw: intent.desiredYaw,
    };
  }

  /**
   * Decide whether the NPC claws this tick — t4c EXTENSION POINT (now wired).
   *
   * When a live human is within {@link NPC_ATTACK_RANGE} and the NPC is off
   * cooldown and un-stunned, this latches `pendingAttack` and starts
   * {@link ATTACK_COOLDOWN_MS} — byte-for-byte what a client ATTACK does in
   * {@link handleMessage}. It deliberately does NOTHING else: it neither opens
   * the claw window nor infects anyone directly. Instead, this very tick,
   * {@link resolveAttacks} opens the window (and buffers the swing VFX) and
   * {@link resolveInfections} turns any human inside
   * {@link INFECTION_CONTACT_RADIUS}. Routing the NPC through that existing
   * resolveAttacks -> resolveInfections flow is the whole point: an NPC claw
   * infects through the IDENTICAL path a player zombie uses, so there is no
   * second infection implementation to keep in sync. Speed/aggro tuning lives
   * here too, and it stays inside the Room so it never overlaps the targeting
   * work in `ai.ts`.
   */
  private decideNpcAttack(npc: Player, humans: readonly Player[]): void {
    // Gate exactly like MessageType.Attack: a stunned zombie can't act and the
    // cooldown throttles claw spam. The NPC is never a spectator and is never
    // `down` here, so those two ATTACK guards are implicitly satisfied already.
    if (npc.isStunned || npc.attackCooldownMs > 0) return;

    // Only commit when a human is actually in reach — otherwise the NPC would
    // burn its cooldown clawing at empty street. This is the ATTACK-INITIATION
    // test; the actual turn still hinges on INFECTION_CONTACT_RADIUS downstream.
    if (!this.humanInClawRange(npc, humans)) return;

    // Latch for THIS tick and start the cooldown — the same two lines the client
    // ATTACK runs (see handleMessage). resolveAttacks()/resolveInfections(),
    // both later in step(), then do the rest through the shared flow above.
    npc.pendingAttack = true;
    npc.attackCooldownMs = ATTACK_COOLDOWN_MS;
  }

  /**
   * Whether any live human sits within claw reach of the NPC on the XZ plane.
   * Distance is centre-to-centre against {@link NPC_ATTACK_RANGE} — the attack
   * INITIATION radius, intentionally a touch wider than the
   * {@link INFECTION_CONTACT_RADIUS} that {@link resolveInfections} requires to
   * actually turn someone — so the NPC commits its claw a hair before contact,
   * just as a human would tap ATTACK on the approach. Compared in squared space
   * to skip a per-candidate square root; `humans` is already the live,
   * infectable set (see {@link liveHumans}), so no team/down re-check is needed.
   */
  private humanInClawRange(npc: Player, humans: readonly Player[]): boolean {
    const r2 = NPC_ATTACK_RANGE * NPC_ATTACK_RANGE;
    for (const human of humans) {
      const dx = human.move.x - npc.move.x;
      const dz = human.move.z - npc.move.z;
      if (dx * dx + dz * dz <= r2) return true;
    }
    return false;
  }

  /**
   * DESIGN §5 step 4. Consume each latched attack request: open the attacker's
   * short attack/claw window and buffer the `attack` event (swing VFX). A HUMAN
   * additionally resolves an instantaneous bat cone hit here; a ZOMBIE's contact
   * infection is handled continuously by {@link resolveInfections} while its
   * window is open. A swing is dropped if the attacker was stunned or downed by
   * an earlier-resolved player this same tick (bat interrupts claw).
   */
  private resolveAttacks(): void {
    for (const p of this.players.values()) {
      if (!p.pendingAttack) continue;
      p.pendingAttack = false;

      if (p.spectator || p.down || p.isStunned) continue;

      p.attackWindowMs = ATTACK_WINDOW_MS;
      this.buffer({ kind: 'attack', actorId: p.id, x: p.move.x, y: p.move.y, z: p.move.z });

      if (p.team === 'human') this.resolveBatSwing(p);
    }
  }

  /**
   * Bat cone hit test for one human attacker (t3a). Every zombie within
   * {@link BAT_RANGE} AND inside the {@link BAT_ARC_DEG} cone centered on the
   * attacker's facing is knocked straight back at {@link BAT_KNOCKBACK} and
   * stunned for {@link STUN_DURATION_MS}. No friendly fire: only zombies are
   * valid targets (downed humans are still team 'human', so they're excluded).
   */
  private resolveBatSwing(attacker: Player): void {
    // Attacker facing on XZ, matching the shared sim's forward axis
    // (forward = (-sin yaw, -cos yaw); yaw 0 faces -Z).
    const fx = -Math.sin(attacker.move.yaw);
    const fz = -Math.cos(attacker.move.yaw);

    for (const target of this.players.values()) {
      if (target === attacker || target.spectator) continue;
      if (target.team !== 'zombie') continue;

      const dx = target.move.x - attacker.move.x;
      const dz = target.move.z - attacker.move.z;
      const dist = Math.hypot(dx, dz);
      if (dist > BAT_RANGE) continue;

      // Cone test: with unit facing and unit target direction, their dot equals
      // cos(angle between), so "in front" means dot >= cos(halfArc).
      if (dist > 1e-6) {
        const dot = (fx * dx + fz * dz) / dist;
        if (dot < BAT_HALF_ARC_COS) continue;
      }

      // HIT — knock the zombie away from the attacker (fall back to the
      // attacker's facing if they are exactly coincident), and stun it.
      let kdx = fx;
      let kdz = fz;
      if (dist > 1e-6) {
        kdx = dx / dist;
        kdz = dz / dist;
      }
      target.kvx = kdx * BAT_KNOCKBACK;
      target.kvz = kdz * BAT_KNOCKBACK;
      target.stunMs = STUN_DURATION_MS;

      this.buffer({
        kind: 'stun',
        actorId: attacker.id,
        targetId: target.id,
        x: target.move.x,
        y: target.move.y,
        z: target.move.z,
      });
    }
  }

  /**
   * DESIGN §5 step 5. For every zombie whose claw window is open and that is not
   * stunned, infect any human within {@link INFECTION_CONTACT_RADIUS} on XZ:
   * down it, start its {@link RESPAWN_DELAY_MS} death-cam, and buffer an
   * `infect` event. A human already down is skipped, so no one is infected twice.
   */
  private resolveInfections(): void {
    const r2 = INFECTION_CONTACT_RADIUS * INFECTION_CONTACT_RADIUS;

    for (const zombie of this.players.values()) {
      if (zombie.spectator || zombie.team !== 'zombie') continue;
      if (zombie.attackWindowMs <= 0 || zombie.isStunned) continue;

      for (const human of this.players.values()) {
        if (human === zombie || human.spectator) continue;
        if (human.team !== 'human' || human.down) continue; // double-infect guard

        const dx = human.move.x - zombie.move.x;
        const dz = human.move.z - zombie.move.z;
        if (dx * dx + dz * dz > r2) continue;

        // Infect: down the human, start its death-cam, and wipe any combat state
        // so it can't keep swinging or sliding while frozen.
        human.down = true;
        human.respawnMs = RESPAWN_DELAY_MS;
        human.stunMs = 0;
        human.attackWindowMs = 0;
        human.pendingAttack = false;
        human.kvx = 0;
        human.kvz = 0;

        this.buffer({
          kind: 'infect',
          actorId: zombie.id,
          targetId: human.id,
          x: human.move.x,
          y: human.move.y,
          z: human.move.z,
        });
      }
    }
  }

  /**
   * Flip any downed player whose death-cam has elapsed onto the zombie team
   * (t3c), clearing its combat state so it resumes control as a zombie with the
   * same movement set but a claw instead of a bat.
   */
  private resolveRespawns(): void {
    for (const p of this.players.values()) {
      if (!p.down || p.respawnMs > 0) continue;
      p.team = 'zombie';
      this.clearCombatState(p);
    }
  }

  /** Reset all combat/infection timers and flags (used on turn / promotion). */
  private clearCombatState(p: Player): void {
    p.stunMs = 0;
    p.attackWindowMs = 0;
    p.attackCooldownMs = 0;
    p.down = false;
    p.respawnMs = 0;
    p.kvx = 0;
    p.kvz = 0;
    p.pendingAttack = false;
    // Refill the stamina reserve and clear the exhaustion latch so a fresh round
    // (or a newly-turned zombie) starts fully rested. resetPlayers() routes
    // through here, so a new lobby resets stamina for everyone too.
    p.stamina = STAMINA_MAX;
    p.exhausted = false;
  }

  /** Buffer a gameplay event for inclusion in the next broadcast snapshot. */
  private buffer(event: GameEvent): void {
    this.events.push(event);
  }

  /* ------------------------------------------------------------------------ */
  /* Snapshots (t1c) + round counts (t3c)                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Build one base snapshot of all active entities and broadcast it to every
   * socket (players and spectators), then broadcast the live team counts.
   * Positions come straight from each player's collision-resolved
   * {@link MoveState}; `kind` reflects the player's team and `state` folds in
   * combat states. Any events buffered since the previous broadcast are drained
   * into this snapshot's optional `events`. `ack` is personalized per recipient.
   */
  private broadcastSnapshot(): void {
    // 1) Build the full authoritative entity list once (see collectEntities).
    const entities = this.collectEntities();

    // Drain the event buffer; only attach `events` when non-empty so idle
    // snapshots stay lean. Slice so each broadcast owns an immutable copy.
    const events = this.events.length > 0 ? this.events.slice() : undefined;
    this.events.length = 0;

    const tick = this.tick;
    for (const p of this.players.values()) {
      // 2) Interest management seam (M7 · t7c): pick the entities THIS client
      //    should receive from the full list. Default: the whole list.
      const forClient = this.entitiesForClient(p, entities);
      // 3) Encoding seam (M7 · t7a/t7b): serialize + send this client's
      //    snapshot. Default: a full JSON SnapshotMessage.
      this.sendSnapshotTo(p, tick, forClient, events);
    }

    this.broadcastRound();
  }

  /**
   * Build one full authoritative snapshot of every simulated (non-spectator)
   * entity. Positions come straight from each player's collision-resolved
   * {@link MoveState}; `kind` reflects the team and `state` folds in combat
   * states. This is the single source the per-client seams below consume.
   */
  private collectEntities(): EntitySnapshot[] {
    const entities: EntitySnapshot[] = [];
    for (const p of this.players.values()) {
      if (p.spectator) continue;
      entities.push({
        id: p.id,
        kind: p.team,
        x: p.move.x,
        y: p.move.y,
        z: p.move.z,
        yaw: p.move.yaw,
        state: deriveState(p),
        // Authoritative sprint reserve (0..1). The NPC never drains, so it
        // reports full; the client HUD renders this as the stamina bar.
        stamina: p.stamina,
      });
    }
    return entities;
  }

  /**
   * Interest-management seam (M7 · t7c): choose which of the full entity list a
   * given client should receive. Each playing client is sent only the entities
   * within its interest radius on the XZ plane — its own entity always included —
   * so the far side of the town is never transmitted to a client that cannot
   * perceive it (see {@link cullByInterest}). Enter/exit hysteresis, carried on
   * the viewer's {@link Player.visibleEntities} set between broadcasts, keeps
   * boundary entities from flickering in and out of the snapshot.
   *
   * Two callers bypass the cull and receive the full list unchanged:
   *  - **Spectators**, who carry no own entity and are meant to watch the whole
   *    town, so there's no viewer position to cull around anyway; and
   *  - the **NPC** (`socket === null`), whose snapshot is never actually sent —
   *    skipping the work (and leaving its unused visible-set untouched) is free.
   *
   * The returned array is always a distinct list (either `all` itself for the
   * bypass, or a fresh filtered array); this method never mutates `all` or its
   * entities, which are shared across every client.
   */
  private entitiesForClient(player: Player, all: EntitySnapshot[]): EntitySnapshot[] {
    // Spectators watch the whole town; the NPC is never sent. Either way there's
    // no viewer entity to cull around, so pass the full list through untouched.
    if (player.spectator || player.socket === null) return all;

    // Cull to this viewer's interest around its authoritative position, applying
    // hysteresis against what it saw last broadcast, then remember the new set so
    // the next broadcast's enter/exit decisions build on it.
    const result = cullByInterest(
      all,
      player.id,
      player.move.x,
      player.move.z,
      player.visibleEntities,
    );
    player.visibleEntities = result.visible;
    return result.entities;
  }

  /**
   * Encoding seam (M7 · t7a/t7b): serialize and send one client's snapshot.
   * Receives the already interest-culled `entities` for this client so encoding
   * never has to know about culling.
   *
   * Two modes, selected by the shared {@link SNAPSHOT_WIRE} flag so both sides
   * always agree:
   *
   *   - `'json'` — the original behaviour: a full JSON {@link SnapshotMessage}
   *     carrying every culled entity, personalized `ack`, and any events.
   *   - `'binary'` — pack the snapshot into a quantized {@link ArrayBuffer}
   *     (t7a) and, when this client has ACKed a snapshot still in its baseline
   *     ring, DELTA-encode against that exact ACKed frame (t7b): only the
   *     entities added/changed since the baseline plus the ids that left. With
   *     no usable baseline yet (first frame, reconnect, or an aged-out ack) a
   *     FULL binary frame is sent instead.
   *
   * The delta is diffed against the entity set THIS client was handed for the
   * baseline tick — so an entity leaving interest naturally shows up as a
   * removed id and one entering as a full add — and only ever against a frame
   * the client has confirmed holding, which is what makes dropped/late acks
   * recover cleanly. Every sent frame (full or delta) records the full culled
   * set for `tick` so future acks can baseline against it.
   */
  private sendSnapshotTo(
    player: Player,
    tick: number,
    entities: EntitySnapshot[],
    events: GameEvent[] | undefined,
  ): void {
    // JSON fallback: keep the original readable path verbatim on both sides.
    if (SNAPSHOT_WIRE === 'json') {
      const snapshot: SnapshotMessage = {
        t: MessageType.Snapshot,
        tick,
        ack: player.lastSeq,
        entities,
      };
      if (events) snapshot.events = events;
      this.send(player, snapshot);
      return;
    }

    // Binary path (t7a) + delta-against-last-acked (t7b).
    const ack = player.lastSeq;
    const baseline =
      player.lastSnapAck !== undefined
        ? player.sentSnapshots.get(player.lastSnapAck)
        : undefined;

    let buffer: ArrayBuffer;
    if (baseline !== undefined && player.lastSnapAck !== undefined) {
      const { changed, removed } = diffSnapshots(baseline, entities);
      const delta: DeltaSnapshot = {
        t: MessageType.Snapshot,
        tick,
        ack,
        baselineTick: player.lastSnapAck,
        entities: changed,
        removed,
      };
      if (events) delta.events = events;
      buffer = encodeSnapshotBinary(delta);
    } else {
      const full: SnapshotMessage = {
        t: MessageType.Snapshot,
        tick,
        ack,
        entities,
      };
      if (events) full.events = events;
      buffer = encodeSnapshotBinary(full);
    }

    // Remember the full culled set for this tick as a future delta baseline,
    // then ship the frame (guarding the socket like {@link send} does).
    player.recordSentSnapshot(tick, entities);
    const socket = player.socket;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(buffer);
    }
  }

  /**
   * Broadcast the authoritative {@link RoundMessage} (t5a/t5b/t5c): the live
   * {@link Round} phase and clock plus the current team scoreline, at the
   * snapshot cadence.
   *
   * Counts (non-spectators only): `zombieCount` is every zombie-team entity —
   * the NPC patient zero included — and `humansAlive` every standing human. The
   * phase-scoped optional fields mirror the frozen wire contract exactly:
   *  - `winner` is attached only while `phase === 'ended'`;
   *  - `readyCount`/`playerCount` are attached only in the `lobby`, so the HUD
   *    can render the "READY n/total" gate, and omitted everywhere else.
   */
  private broadcastRound(): void {
    let humansAlive = 0;
    let zombieCount = 0;
    for (const p of this.players.values()) {
      if (p.spectator) continue;
      if (p.team === 'zombie') zombieCount++;
      else if (!p.down) humansAlive++;
    }

    const round: RoundMessage = {
      t: MessageType.Round,
      phase: this.round.phase,
      timeLeftMs: this.round.timeLeftMs,
      humansAlive,
      zombieCount,
    };

    if (this.round.phase === 'ended' && this.round.winner !== undefined) {
      round.winner = this.round.winner;
    }
    if (this.round.phase === 'lobby') {
      round.readyCount = this.readyCount();
      round.playerCount = this.activeCount();
    }

    for (const p of this.players.values()) this.send(p, round);
  }

  /* ------------------------------------------------------------------------ */
  /* Helpers                                                                  */
  /* ------------------------------------------------------------------------ */

  /** Serialize and send a message to a player if its socket is open. */
  private send(
    player: Player,
    msg: WelcomeMessage | SnapshotMessage | RoundMessage | PongMessage,
  ): void {
    if (player.socket === null || player.socket.readyState !== WebSocket.OPEN) return;
    player.socket.send(encode(msg));
  }
}

/**
 * Decay one axis of a knockback velocity by one tick, snapping to exactly zero
 * once it drops below {@link KNOCKBACK_EPSILON} so the impulse settles cleanly
 * instead of trailing an ever-smaller float forever.
 */
function decayKnockback(v: number): number {
  const decayed = v * KNOCKBACK_DECAY_PER_TICK;
  return Math.abs(decayed) < KNOCKBACK_EPSILON ? 0 : decayed;
}

/**
 * Derive the coarse animation/combat state for a player entity. Combat states
 * win over movement, most-incapacitated first: `down` (turning) > `stun`
 * (bat-hit) > `attack` (mid swing/claw window). Otherwise the M2 movement
 * derivation applies: airborne (`!grounded`) reads as 'jump'; on the ground,
 * no direction key held is 'idle', otherwise crawl mode wins ('crawl'), then
 * Run ('run'), else 'walk'.
 */
function deriveState(p: Player): EntityState {
  if (p.down) return 'down';
  if (p.isStunned) return 'stun';
  if (p.attackWindowMs > 0) return 'attack';

  const move = p.move;
  const keys = p.input.keys;
  if (!move.grounded) return 'jump';

  const moving =
    hasKey(keys, InputKey.Forward) ||
    hasKey(keys, InputKey.Back) ||
    hasKey(keys, InputKey.Left) ||
    hasKey(keys, InputKey.Right);

  if (!moving) return 'idle';
  if (move.crawling) return 'crawl';
  if (hasKey(keys, InputKey.Run)) return 'run';
  return 'walk';
}
