import type { WebSocket } from 'ws';
import { createMoveState, type MoveState } from '@crawling-dark/shared';

/**
 * Authoritative server-side model of one connected client (M2 · t2c).
 *
 * A `Player` owns its network socket, the last input frame the client sent,
 * and the authoritative {@link MoveState} the shared simulation advances each
 * tick (yaw-relative movement, gravity/jump on Y, and — resolved by the room —
 * circle-vs-AABB collision against the town on XZ). Player entities are the
 * only things that appear in a {@link SnapshotMessage}; spectators (connections
 * past {@link MAX_PLAYERS}) keep a `Player` record so they still receive
 * snapshots, but carry no simulated entity.
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

  /** The underlying `ws` socket used to push messages to this client. */
  readonly socket: WebSocket;

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
   * receive every snapshot but are not simulated and produce no entity.
   */
  readonly spectator: boolean;

  constructor(id: number, socket: WebSocket, spectator: boolean, x: number, z: number) {
    this.id = id;
    this.socket = socket;
    this.spectator = spectator;
    this.move = createMoveState({ x, z });
  }
}
