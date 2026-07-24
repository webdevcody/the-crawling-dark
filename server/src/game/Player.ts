import type { WebSocket } from 'ws';
import {
  createMoveState,
  STAMINA_MAX,
  SNAPSHOT_BASELINE_RING,
  type MoveState,
  type EntityKind,
  type EntitySnapshot,
} from '@crawling-dark/shared';

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
   *
   * REBINDABLE (M7 · t7d): no longer `readonly`. On a reconnect the {@link Room}
   * hands this player a brand-new socket (the fresh connection) in place of the
   * dead one, so the *same* Player — id, team, position, combat state — keeps
   * talking to the client over the new pipe. It is also nulled the moment a
   * drop is detected (while the player sits in its grace window) so the server
   * never tries to write to a closed socket.
   */
  socket: WebSocket | null;

  /** Display name claimed via {@link JoinMessage}; empty until a JOIN arrives. */
  name = '';

  /* ---------------------------------------------------------------------- */
  /* Reconnect / session (M7 · t7d)                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Opaque, room-unique session token minted by the {@link Room} on first join
   * and shipped in this player's {@link WelcomeMessage}. A later {@link
   * JoinMessage} echoing this exact token lets the room reclaim this identity
   * (rebind {@link socket}, keep id/team/position/combat) instead of spawning a
   * new player. Empty string for the NPC, which has no client and never
   * reconnects. Stays constant across a reconnect — the same token is re-issued.
   */
  token = '';

  /**
   * True while this player is inside its post-drop grace window: the socket has
   * closed but the entity is deliberately kept in the world (so teammates still
   * see it) awaiting a possible reconnect. While set, the {@link Room} freezes
   * the player — {@link input} is zeroed so it stands idle rather than acting on
   * the last held keys — and counts {@link graceMs} down each tick. Cleared when
   * the client reconnects; if the timer instead reaches 0 the player is removed.
   */
  disconnected = false;

  /**
   * Remaining grace time in milliseconds while {@link disconnected} (0 = none
   * pending). Seeded to {@link RECONNECT_GRACE_MS} on a detected drop and
   * decremented by one {@link TICK_MS} per tick in lockstep with the sim, just
   * like the combat timers. When it hits 0 without a reconnect the {@link Room}
   * removes the player through the normal path so round/win logic sees it leave.
   */
  graceMs = 0;

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

  /* ---------------------------------------------------------------------- */
  /* Snapshot delta baseline (M7 · t7b)                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Snapshot tick this client has confirmed fully applying, captured from
   * {@link InputMessage.snapAck}. `undefined` until the first ack arrives (so
   * the very first snapshot a client receives is always a FULL frame). The
   * {@link Room} delta-encodes the next snapshot against {@link sentSnapshots}
   * `[lastSnapAck]` whenever that tick is still in the ring. Monotonic — a
   * stale/reordered ack never rolls the confirmed baseline backwards.
   */
  lastSnapAck?: number;

  /**
   * Ring of recently *sent* snapshots for THIS client, keyed by tick → the
   * exact (already interest-culled) entity set that went out on that tick.
   * Capped at {@link SNAPSHOT_BASELINE_RING} entries (oldest evicted first).
   * When the client ACKs a tick still present here, that stored set is the
   * baseline the next delta is diffed against — so a delta is only ever built
   * against a frame the client is guaranteed to hold. See
   * {@link recordSentSnapshot}.
   */
  readonly sentSnapshots = new Map<number, EntitySnapshot[]>();

  /**
   * True when this connection exceeded the active-player cap. Spectators still
   * receive every snapshot but are not simulated and produce no entity — they
   * therefore never carry combat state.
   */
  readonly spectator: boolean;

  /**
   * Lobby ready-up flag (M5 · t5b). A connected, playing client toggles this via
   * {@link ReadyMessage}; the round state machine counts ready, non-spectator,
   * non-NPC players each tick and starts the countdown once
   * {@link MIN_PLAYERS_TO_START} are ready — readiness is the single source of
   * truth, polled by the machine rather than starting the round inline. Defaults
   * to `false`, and the Room clears it on every return to the lobby so each new
   * round demands a fresh ready-up. Spectators and NPCs can never toggle it, so
   * it stays `false` for them.
   */
  ready = false;

  /* ---------------------------------------------------------------------- */
  /* Stamina / sprint gating (M6 · t6b)                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Server-authoritative sprint stamina, a fraction in `[0, STAMINA_MAX]`
   * (1 = rested, 0 = spent). The {@link Room} drains it every tick the player is
   * *actually* sprinting and regenerates it otherwise (clamped to that range),
   * then ships it in the snapshot so the client HUD can draw the bar. Starts full
   * and is reset to full on every round reset / turn (see
   * {@link Room.clearCombatState}). The NPC never sprints, so its value simply
   * stays at {@link STAMINA_MAX} and it always reports a full bar.
   */
  stamina = STAMINA_MAX;

  /**
   * Exhaustion latch. Set `true` the tick stamina hits 0; while it holds, the
   * {@link Room} masks the {@link InputKey.Run} bit out of the keys it hands to
   * the shared `step`, pinning the player to walk speed. It clears only once
   * stamina has regenerated back up to {@link STAMINA_MIN_TO_SPRINT}, so a spent
   * runner must rebuild a real buffer before sprint re-enables rather than
   * flickering back on at the first regenerated tick.
   */
  exhausted = false;

  /* ---------------------------------------------------------------------- */
  /* Interest management (M7 · t7c)                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Ids of the entities this connection was sent in its *last* snapshot — the
   * viewer's currently-visible set for per-client interest culling (M7 · t7c).
   * The {@link Room} feeds this into {@link cullByInterest} each broadcast and
   * stores the returned set back here, which is what powers the enter/exit
   * hysteresis: an entity already in this set holds interest out to the wider
   * exit radius, so an entity hovering on the boundary doesn't flicker in and out
   * of the snapshot tick to tick. Starts empty (a fresh viewer has seen nothing),
   * and naturally sheds stale ids because it is rebuilt from the live entity list
   * every broadcast. Unused for spectators and the NPC, whose snapshots bypass
   * the cull entirely.
   */
  visibleEntities: Set<number> = new Set();

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

  /**
   * Record the entity set just sent to this client on `tick` as a candidate
   * delta baseline (M7 · t7b). A shallow copy is stored so a later rebuild of
   * the source array can't corrupt the baseline; the entity objects themselves
   * are immutable by construction (freshly built each broadcast). Evicts the
   * oldest entry once the ring exceeds {@link SNAPSHOT_BASELINE_RING}.
   */
  recordSentSnapshot(tick: number, entities: readonly EntitySnapshot[]): void {
    this.sentSnapshots.set(tick, entities.slice());
    while (this.sentSnapshots.size > SNAPSHOT_BASELINE_RING) {
      const oldest = this.sentSnapshots.keys().next().value;
      if (oldest === undefined) break;
      this.sentSnapshots.delete(oldest);
    }
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
