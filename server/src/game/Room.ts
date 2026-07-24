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
  MAP_SIZE,
  MAX_PLAYERS,
  MOVE_SPEED_WALK,
  MOVE_SPEED_RUN,
  MOVE_SPEED_CRAWL,
  PLAYER_RADIUS,
  type EntitySnapshot,
  type EntityState,
  type WelcomeMessage,
  type SnapshotMessage,
  type PongMessage,
  type WireData,
} from '@crawling-dark/shared';
import { Player } from './Player';

/**
 * The single game room for The Crawling Dark (M1 · t1b/t1c/t1e).
 *
 * Responsibilities:
 *  - Registry: assign a distinct, monotonically increasing `playerId` per
 *    connection, spawn each player spread around the origin, cap the active
 *    roster at {@link MAX_PLAYERS} (spillover spectates), and clean up on close.
 *  - Simulation: a drift-resistant, fixed-timestep loop at {@link TICK_RATE} Hz
 *    that integrates world-axis movement from each player's latest input.
 *  - Snapshots: every {@link SNAPSHOT_TICK_INTERVAL} ticks, broadcast one base
 *    snapshot to all sockets with a per-recipient `ack` (their last applied seq).
 *
 * Movement is intentionally minimal for M1: world-axis only, no yaw-relative
 * steering, no collision beyond clamping to the map bounds — "raw input echoed
 * by the server."
 */

/** Fixed map seed for M1; deterministic town geometry lands in M2. */
const MAP_SEED = 1;

/** Radius of the spawn ring around the origin, in meters. */
const SPAWN_RING_RADIUS = 4;

/** Golden angle (radians) used to spread successive spawns around the ring. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Half the map extent minus the player radius: the clamp bound on X and Z. */
const MOVE_BOUND = MAP_SIZE / 2 - PLAYER_RADIUS;

/** Fixed simulation delta in seconds (one tick). */
const DT = TICK_MS / 1000;

/**
 * Maximum fixed steps advanced per timer wake. Caps catch-up work so a stalled
 * process (GC pause, debugger) cannot trigger a spiral of death.
 */
const MAX_CATCHUP_STEPS = 5;

export class Room {
  /** All connected clients (active players and spectators), keyed by id. */
  private readonly players = new Map<number, Player>();

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
      if (!p.spectator) n++;
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
   * messages (ATTACK, READY) are ignored; they land in later milestones.
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

      case MessageType.Ping: {
        // t1e: echo the probe id straight back so the client can time RTT.
        const pong: PongMessage = { t: MessageType.Pong, id: msg.id };
        this.send(player, pong);
        break;
      }

      default:
        // ATTACK / READY: no-op in M1.
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

  /** Advance exactly one fixed tick: apply inputs, then maybe broadcast. */
  private step(): void {
    for (const p of this.players.values()) {
      if (p.spectator) continue;
      this.integrate(p);
    }

    this.tick++;

    if (this.tick % SNAPSHOT_TICK_INTERVAL === 0) {
      this.broadcastSnapshot();
    }
  }

  /**
   * Integrate one player's world-axis movement for a single tick.
   *
   * Direction from held keys: Forward→−Z, Back→+Z, Left→−X, Right→+X; diagonals
   * are normalized. Speed is Run > Crawl > Walk. Position is clamped to the map
   * bounds; `y` is pinned to 0. `yaw` is stored from the input but never steers
   * movement in M1.
   */
  private integrate(p: Player): void {
    p.yaw = p.input.yaw;

    const keys = p.input.keys;
    let dx = 0;
    let dz = 0;
    if (hasKey(keys, InputKey.Forward)) dz -= 1;
    if (hasKey(keys, InputKey.Back)) dz += 1;
    if (hasKey(keys, InputKey.Left)) dx -= 1;
    if (hasKey(keys, InputKey.Right)) dx += 1;

    const len = Math.hypot(dx, dz);
    if (len > 0) {
      const speed = hasKey(keys, InputKey.Run)
        ? MOVE_SPEED_RUN
        : hasKey(keys, InputKey.Crawl)
          ? MOVE_SPEED_CRAWL
          : MOVE_SPEED_WALK;
      const scale = (speed * DT) / len;
      p.x = clamp(p.x + dx * scale, -MOVE_BOUND, MOVE_BOUND);
      p.z = clamp(p.z + dz * scale, -MOVE_BOUND, MOVE_BOUND);
    }

    p.y = 0;
  }

  /* ------------------------------------------------------------------------ */
  /* Snapshots (t1c)                                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * Build one base snapshot of all active entities and broadcast it to every
   * socket (players and spectators). `ack` is personalized per recipient to
   * that client's last applied input seq.
   */
  private broadcastSnapshot(): void {
    const entities: EntitySnapshot[] = [];
    for (const p of this.players.values()) {
      if (p.spectator) continue;
      entities.push({
        id: p.id,
        kind: 'human',
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        state: deriveState(p.input.keys),
      });
    }

    const tick = this.tick;
    for (const p of this.players.values()) {
      const snapshot: SnapshotMessage = {
        t: MessageType.Snapshot,
        tick,
        ack: p.lastSeq,
        entities,
      };
      this.send(p, snapshot);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Helpers                                                                  */
  /* ------------------------------------------------------------------------ */

  /** Serialize and send a message to a player if its socket is open. */
  private send(player: Player, msg: WelcomeMessage | SnapshotMessage | PongMessage): void {
    if (player.socket.readyState !== WebSocket.OPEN) return;
    player.socket.send(encode(msg));
  }
}

/** Clamp `v` into the inclusive range [`min`, `max`]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Derive the coarse animation state from held keys: any movement direction
 * plus Run→'run', plus Crawl→'crawl', otherwise 'walk'; no movement→'idle'.
 * Uses the same net-direction test as {@link Room.integrate} so a self-
 * cancelling key combo (Forward+Back) reads as 'idle'.
 */
function deriveState(keys: number): EntityState {
  let dx = 0;
  let dz = 0;
  if (hasKey(keys, InputKey.Forward)) dz -= 1;
  if (hasKey(keys, InputKey.Back)) dz += 1;
  if (hasKey(keys, InputKey.Left)) dx -= 1;
  if (hasKey(keys, InputKey.Right)) dx += 1;

  if (dx === 0 && dz === 0) return 'idle';
  if (hasKey(keys, InputKey.Run)) return 'run';
  if (hasKey(keys, InputKey.Crawl)) return 'crawl';
  return 'walk';
}
