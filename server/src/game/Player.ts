import type { WebSocket } from 'ws';

/**
 * Authoritative server-side model of one connected client (M1 · t1b).
 *
 * A `Player` owns its network socket, the last input frame the client sent,
 * and the world-space transform the simulation integrates each tick. Player
 * entities are the only things that appear in a {@link SnapshotMessage} during
 * M1; spectators (connections past {@link MAX_PLAYERS}) keep a `Player` record
 * so they still receive snapshots, but carry no simulated entity.
 */

/**
 * The most recent raw input a client has sent. Movement is derived from this
 * every tick by the {@link Room} loop; `yaw` is stored (for facing) but is not
 * used to steer movement in M1 (movement is world-axis only).
 */
export interface PlayerInput {
  /** Held-key bitmask; test bits with {@link InputKey} / {@link hasKey}. */
  keys: number;
  /** Aim/look yaw in radians. */
  yaw: number;
}

/** One connected client: identity, transform, latest input, and its socket. */
export class Player {
  /** Room-unique, monotonically increasing id. Never reused across the room. */
  readonly id: number;

  /** The underlying `ws` socket used to push messages to this client. */
  readonly socket: WebSocket;

  /** Display name claimed via {@link JoinMessage}; empty until a JOIN arrives. */
  name = '';

  /** World-space position in meters. `y` stays 0 in M1 (no jump/gravity). */
  x = 0;
  y = 0;
  z = 0;

  /** Facing angle around the Y axis in radians (mirrors the latest input yaw). */
  yaw = 0;

  /** Latest raw input frame; the tick loop integrates movement from `keys`. */
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
    this.x = x;
    this.z = z;
  }
}
