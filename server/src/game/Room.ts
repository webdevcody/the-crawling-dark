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
  PLAYER_RADIUS,
  generateWorld,
  collideCircleXZ,
  step,
  type MoveState,
  type World,
  type EntitySnapshot,
  type EntityState,
  type WelcomeMessage,
  type SnapshotMessage,
  type PongMessage,
  type WireData,
} from '@crawling-dark/shared';
import { Player } from './Player';

/**
 * The single game room for The Crawling Dark (M2 · t2c).
 *
 * Responsibilities:
 *  - Registry: assign a distinct, monotonically increasing `playerId` per
 *    connection, spawn each player spread around the origin, cap the active
 *    roster at {@link MAX_PLAYERS} (spillover spectates), and clean up on close.
 *  - Simulation: a drift-resistant, fixed-timestep loop at {@link TICK_RATE} Hz
 *    that advances each player's authoritative {@link MoveState} via the shared,
 *    deterministic {@link step}, then resolves circle-vs-AABB collision against
 *    the seeded {@link World} so nobody walks through buildings or the wall.
 *  - Snapshots: every {@link SNAPSHOT_TICK_INTERVAL} ticks, broadcast one base
 *    snapshot to all sockets with a per-recipient `ack` (their last applied seq).
 *
 * Movement is now the real M2 model: yaw-relative horizontal motion with
 * gravity/jump on Y (both from the shared sim) and authoritative XZ collision
 * against the town generated here from {@link MAP_SEED}.
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

export class Room {
  /** All connected clients (active players and spectators), keyed by id. */
  private readonly players = new Map<number, Player>();

  /**
   * The seeded town, generated ONCE from {@link MAP_SEED}. The identical seed is
   * sent in WELCOME so every client rebuilds byte-for-byte the same geometry;
   * the server collides players against this world's AABB footprints.
   */
  private readonly world: World = generateWorld(MAP_SEED);

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
   * Integrate one player's authoritative movement for a single fixed tick.
   *
   * Pipeline (see DESIGN §5): advance the unobstructed kinematics with the
   * shared, deterministic {@link step} (yaw-relative XZ motion + gravity/jump on
   * Y), then resolve circle-vs-AABB collision on the XZ plane against the seeded
   * world via {@link collideCircleXZ}. Y is left exactly as the sim produced it
   * (gravity/jump/ground clamp); only X and Z are collision-corrected, so a
   * player can neither pass through a building nor cross the perimeter wall.
   */
  private integrate(p: Player): void {
    const next = step(p.move, { keys: p.input.keys, yaw: p.input.yaw }, DT);
    const resolved = collideCircleXZ(this.world, next.x, next.z, PLAYER_RADIUS);
    p.move = { ...next, x: resolved.x, z: resolved.z };
  }

  /* ------------------------------------------------------------------------ */
  /* Snapshots (t1c)                                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * Build one base snapshot of all active entities and broadcast it to every
   * socket (players and spectators). Positions come straight from each player's
   * collision-resolved {@link MoveState}. `ack` is personalized per recipient to
   * that client's last applied input seq.
   */
  private broadcastSnapshot(): void {
    const entities: EntitySnapshot[] = [];
    for (const p of this.players.values()) {
      if (p.spectator) continue;
      entities.push({
        id: p.id,
        kind: 'human',
        x: p.move.x,
        y: p.move.y,
        z: p.move.z,
        yaw: p.move.yaw,
        state: deriveState(p.move, p.input.keys),
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

/**
 * Derive the coarse animation state from the authoritative {@link MoveState}
 * plus the held keys: airborne (`!grounded`) reads as 'jump'; on the ground,
 * no direction key held is 'idle', otherwise crawl mode wins ('crawl'), then
 * Run ('run'), else 'walk'. The crawl-before-run priority mirrors the shared
 * sim's `moveSpeed` (you cannot sprint while low-profile).
 */
function deriveState(move: MoveState, keys: number): EntityState {
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
