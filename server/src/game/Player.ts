import type { WebSocket } from 'ws';
import { createMoveState, type MoveState, type EntityKind } from '@crawling-dark/shared';

/**
 * Authoritative server-side model of one connected client (M3 · t3a/t3b/t3c).
 *
 * A `Player` owns its network socket, the last input frame the client sent,
 * and the authoritative {@link MoveState} the shared simulation advances each
 * tick (yaw-relative movement, gravity/jump on Y, and — resolved by the room —
 * circle-vs-AABB collision against the town on XZ). Player entities are the
 * only things that appear in a {@link SnapshotMessage}; spectators (connections
 * past {@link MAX_PLAYERS}) keep a `Player` record so they still receive
 * snapshots, but carry no simulated entity.
 *
 * M3 adds the combat & infection state: which {@link team} the player is on,
 * and a small set of millisecond countdown timers (stun, attack cooldown, the
 * attack/claw window, and the down->respawn delay) that the {@link Room} ticks
 * down by one fixed {@link TICK_MS} each step. Keeping these as plain remaining-
 * ms counters (rather than absolute deadlines read off a clock) keeps combat
 * fully deterministic and in lockstep with the fixed-timestep sim.
 */

/**
 * The most recent raw input a client has sent. Movement is derived from this
 * every tick by the {@link Room} loop: `keys` drive direction/jump/crawl and
 * `yaw` steers the (now yaw-relative) horizontal motion.
 */
export interface PlayerInput {
  /** Held-key bitmask; test bits with {@link InputKey} / {@link hasKey}. */
  keys: number;
  /** Aim/look yaw in radians. */
  yaw: number;
}

/** One connected client: identity, movement state, latest input, and its socket. */
export class Player {
  /** Room-unique, monotonically increasing id. Never reused across the room. */
  readonly id: number;

  /**
   * The underlying `ws` socket used to push messages to this client, or `null`
   * for a server-spawned NPC (the M4 patient-zero zombie), which has no client
   * to talk to. {@link Room.send} skips any player whose socket is `null`.
   */
  readonly socket: WebSocket | null;

  /** Display name claimed via {@link JoinMessage}; empty until a JOIN arrives. */
  name = '';

  /**
   * Authoritative kinematic state (position, facing, vertical velocity, and the
   * grounded/crawling latches). Advanced each tick by the shared `step`, then
   * XZ-collision-corrected by the {@link Room}. Snapshots read straight from here.
   */
  move: MoveState;

  /** Latest raw input frame; the tick loop integrates movement from `keys`/`yaw`. */
  input: PlayerInput = { keys: 0, yaw: 0 };

  /** Highest input `seq` applied so far; echoed back per-recipient as snapshot `ack`. */
  lastSeq = 0;

  /**
   * True when this connection exceeded the active-player cap. Spectators still
   * receive every snapshot but are not simulated and produce no entity — they
   * therefore never carry combat state.
   */
  readonly spectator: boolean;

  /* ---------------------------------------------------------------------- */
  /* Combat & infection state (M3)                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Which side this player fights for. Everyone starts `'human'`; a player flips
   * to `'zombie'` either as the temporary M3 "patient zero" scaffold (see
   * {@link Room.ensurePatientZero}) or after being infected and respawning. A
   * zombie uses the same movement set but claws (infects) instead of batting.
   * The snapshot's `kind` is derived straight from this.
   */
  team: EntityKind = 'human';

  /**
   * Remaining stun time in milliseconds (0 = not stunned). Set to
   * {@link STUN_DURATION_MS} when hit by a bat; decremented by {@link TICK_MS}
   * each tick. While stunned a player cannot walk or attack, and a stunned
   * zombie cannot infect — but it still slides under any active knockback.
   */
  stunMs = 0;

  /**
   * Remaining attack-cooldown time in milliseconds (0 = ready to swing/claw).
   * Set to {@link ATTACK_COOLDOWN_MS} the moment an ATTACK is accepted so swings
   * are rate-limited regardless of how fast the client spams the button.
   */
  attackCooldownMs = 0;

  /**
   * Remaining time in milliseconds that this player's attack "window" is open
   * (0 = closed). Opened to a short fixed duration when an ATTACK is accepted.
   * It serves two purposes: it drives the `attack` animation state in snapshots
   * (both bat swings and zombie claws), and for a ZOMBIE it is the live
   * contact-infection window — any human within {@link INFECTION_CONTACT_RADIUS}
   * while this is > 0 (and the zombie is not stunned) gets infected.
   */
  attackWindowMs = 0;

  /**
   * True while this player is "downed": a human that a zombie has infected and
   * that is playing out its ~3 s death-cam before respawning on the zombie team.
   * A down player is frozen (ignores input, no gravity/knockback), cannot attack,
   * and cannot be infected again (the double-infection guard) or bat-targeted.
   */
  down = false;

  /**
   * Remaining death-cam time in milliseconds before a {@link down} player
   * respawns as a zombie. Only meaningful while {@link down} is true; set to
   * {@link RESPAWN_DELAY_MS} on infection and counted down each tick.
   */
  respawnMs = 0;

  /**
   * Horizontal knockback velocity (meters/second) on the X and Z axes. The
   * shared {@link MoveState} intentionally carries no horizontal momentum (see
   * `sim.ts`), so a bat hit's knockback lives here instead: the room adds
   * `kvx*dt / kvz*dt` to the post-`step` position each tick, then decays these
   * toward zero, before resolving world collision.
   */
  kvx = 0;
  kvz = 0;

  /**
   * Latched request for a single ATTACK, set when an ATTACK message is accepted
   * and consumed on the next {@link Room.step} so the swing/claw resolves inside
   * the fixed-timestep pipeline (DESIGN §5, steps 4–5) rather than off a socket
   * callback. At most one attack is buffered per cooldown.
   */
  pendingAttack = false;

  /**
   * True for the server-controlled NPC zombie (M4 · t4a). An NPC carries the
   * exact same combat/movement state as a player — so infections, bat swings,
   * snapshots, and the turn flow all treat it uniformly — but it has no socket
   * and is steered by {@link ZombieAI} instead of client INPUT frames.
   */
  readonly isNpc: boolean;

  constructor(
    id: number,
    socket: WebSocket | null,
    spectator: boolean,
    x: number,
    z: number,
    isNpc = false,
  ) {
    this.id = id;
    this.socket = socket;
    this.spectator = spectator;
    this.isNpc = isNpc;
    this.move = createMoveState({ x, z });
  }

  /** True while a stun timer is still running (bat-hit crowd control). */
  get isStunned(): boolean {
    return this.stunMs > 0;
  }

  /** True while downed and playing out the death-cam before respawning. */
  get isDown(): boolean {
    return this.down;
  }
}
