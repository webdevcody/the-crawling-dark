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
  generateWorld,
  collideCircleXZ,
  step,
  type World,
  type EntitySnapshot,
  type EntityState,
  type GameEvent,
  type WelcomeMessage,
  type SnapshotMessage,
  type RoundMessage,
  type PongMessage,
  type WireData,
} from '@crawling-dark/shared';
import { Player } from './Player';
import { ZombieAI, forwardFromYaw, type ZombieIntent } from './ai';

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
   */
  private readonly zombieAI = new ZombieAI(this.world);

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

  /** Count of active (non-spectator) players currently simulated. */
  private activeCount(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (!p.spectator && !p.isNpc) n++;
    }
    return n;
  }

  /**
   * Register a freshly connected socket: assign a distinct id, decide whether
   * it is a spectator (roster already at {@link MAX_PLAYERS}), place it on the
   * spawn ring, store it, and send the one-shot {@link WelcomeMessage}.
   */
  join(socket: WebSocket): Player {
    const id = this.nextPlayerId++;
    const spectator = this.activeCount() >= MAX_PLAYERS;

    // Spread spawns around a small ring so overlapping tabs don't stack.
    const angle = id * GOLDEN_ANGLE;
    const x = spectator ? 0 : Math.cos(angle) * SPAWN_RING_RADIUS;
    const z = spectator ? 0 : Math.sin(angle) * SPAWN_RING_RADIUS;

    const player = new Player(id, socket, spectator, x, z);
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

      case MessageType.Ping: {
        // t1e: echo the probe id straight back so the client can time RTT.
        const pong: PongMessage = { t: MessageType.Pong, id: msg.id };
        this.send(player, pong);
        break;
      }

      default:
        // READY: no-op until the M5 lobby/round state machine.
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
   *  - ensure the single NPC patient-zero zombie exists (M4 · t4a);
   *  - step 2: integrate each active player's movement (honoring stun/down);
   *  - step 3: advance the NPC zombie AI (seek + avoid + contact attack);
   *  - step 4: resolve bat swings (cone hit -> stun + knockback);
   *  - step 5: resolve infections (open zombie window -> down human);
   *  - flip any elapsed death-cams onto the zombie team;
   *  - every ~2nd tick, broadcast a snapshot + round counts.
   *
   * (The round state machine — §5 step 6 — arrives in M5; the count-only ROUND
   * stands in until then.)
   */
  private step(): void {
    this.ensureNpcZombie();

    // Step 2 — integrate the human-controlled players from their inputs.
    for (const p of this.players.values()) {
      if (p.spectator || p.isNpc) continue;
      this.integrate(p);
    }

    // Step 3 — advance the NPC zombie AI (seek + building avoidance, then its
    // contact-attack decision) now that the humans have moved this tick.
    this.updateNpcs();

    this.resolveAttacks();
    this.resolveInfections();
    this.resolveRespawns();

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
    const keys = p.isStunned ? 0 : p.input.keys;
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

  /* ------------------------------------------------------------------------ */
  /* Combat resolution (t3a/t3b/t3c)                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * Ensure the single NPC "patient zero" zombie exists once a game is under way
   * (M4 · t4a). Standing in for the M5 round state machine, we treat "enough
   * humans have connected to play" ({@link MIN_PLAYERS_TO_START} active players)
   * as the round start and, exactly once, spawn one server-controlled zombie out
   * on the ring road. The horde then grows ONLY from turned players: no further
   * NPCs are ever spawned, and no human is auto-promoted.
   */
  private ensureNpcZombie(): void {
    if (this.hasNpc()) return;
    if (this.activeCount() < MIN_PLAYERS_TO_START) return;
    this.spawnNpcZombie();
  }

  /** Whether the lone NPC patient-zero zombie has already been spawned. */
  private hasNpc(): boolean {
    for (const p of this.players.values()) {
      if (p.isNpc) return true;
    }
    return false;
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
      });
    }

    // Drain the event buffer; only attach `events` when non-empty so idle
    // snapshots stay lean. Slice so each broadcast owns an immutable copy.
    const events = this.events.length > 0 ? this.events.slice() : undefined;
    this.events.length = 0;

    const tick = this.tick;
    for (const p of this.players.values()) {
      const snapshot: SnapshotMessage = {
        t: MessageType.Snapshot,
        tick,
        ack: p.lastSeq,
        entities,
      };
      if (events) snapshot.events = events;
      this.send(p, snapshot);
    }

    this.broadcastRound();
  }

  /**
   * Broadcast a lightweight {@link RoundMessage} carrying live team counts so
   * the HUD can read them (t3c): humans still alive (human team, not down, not
   * spectator) and zombies (zombie team, not spectator).
   *
   * NOTE: `phase`/`timeLeftMs` are placeholders until M5 builds the real round
   * state machine (lobby -> countdown -> active -> ended) with the 5:00 clock
   * and win/lose. M3 only needs the counts.
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
      phase: 'active',
      timeLeftMs: 0,
      humansAlive,
      zombieCount,
    };
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
