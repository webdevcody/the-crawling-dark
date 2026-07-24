/**
 * Client-side prediction & reconciliation for the LOCAL player (M6 · t6a).
 *
 * Until now every body on screen — including the one you drive — was rendered
 * from interpolated server snapshots (~{@link INTERP_BUFFER_MS} in the past), so
 * your own movement lagged your keystrokes by a round-trip plus the interpolation
 * delay. That is fine for remote players (whose true state you can never know
 * sooner than the wire allows) but it makes YOUR input feel mushy and rubber-band
 * under latency.
 *
 * `Predictor` fixes this the standard way, and ONLY for the local player:
 *
 *   1. PREDICT — every render frame, immediately advance a locally-owned
 *      {@link MoveState} through the exact same shared kinematics the server runs
 *      ({@link step} + {@link collideCircleXZ}), so the body reacts to input on the
 *      very frame the key is pressed instead of a round-trip later.
 *   2. RECORD — remember each applied input keyed by its monotonic `seq` in an
 *      input history, so it can be replayed later.
 *   3. RECONCILE — when an authoritative snapshot arrives, snap the predicted
 *      state back onto the server's version of the local player, discard every
 *      input the server has already processed (`seq <= ack`), and re-apply the
 *      still-unacknowledged tail. The result is a corrected prediction that
 *      already accounts for inputs in flight, so the correction is invisible under
 *      normal latency (no visible snap, no rubber-band).
 *
 * The whole scheme hinges on the client and server running BYTE-FOR-BYTE identical
 * math: this module deliberately reuses the shared, pure {@link step} and
 * {@link collideCircleXZ} rather than reimplementing movement, and mirrors the
 * server's ordering (`step` first, then resolve XZ against the town — see
 * `Room.integrate`). Because {@link step} is framerate-independent, predicting with
 * the client's variable per-frame `dt` (the server integrates a FIXED tick `dt`)
 * only ever produces small, transient drift that the next reconcile erases.
 *
 * Remote entities are untouched: they keep flowing through the interpolator. This
 * module knows nothing about Three.js — the render loop reads {@link predicted} and
 * overwrites just the local entity's transform upstream of the mesh sync.
 */

import {
  PLAYER_RADIUS,
  step,
  collideCircleXZ,
  createMoveState,
  type MoveState,
  type World,
} from '@crawling-dark/shared';

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Height (meters) below which the server's reported `y` is treated as "on the
 * ground". Snapshots are plain floats and the ground clamp lands at exactly `0`,
 * but we keep a hair of tolerance so a value that is `0` bar rounding still
 * rebuilds a grounded base (matching the sim's own `y <= 0` clamp semantics).
 */
const GROUND_EPSILON = 1e-4;

/* -------------------------------------------------------------------------- */
/* Input history                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One recorded local input frame, keyed by the wire `seq` the server echoes back
 * in {@link import('@crawling-dark/shared').SnapshotMessage.ack}. Holds exactly the
 * fields {@link step} consumes plus the `dt` it was applied with, so reconciliation
 * can replay the frame identically.
 */
interface RecordedInput {
  /** Monotonic input sequence number (from `Connection.sendInput`). */
  seq: number;
  /** Held-key bitmask that was sent this frame. */
  keys: number;
  /** Look yaw (radians) that was sent this frame. */
  yaw: number;
  /** Frame delta (seconds) the input was integrated with. */
  dt: number;
}

/**
 * The render-relevant slice of the predicted state the loop overlays onto the
 * local entity — mirrors the numeric transform fields of an interpolated entity.
 */
export interface PredictedTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/* -------------------------------------------------------------------------- */
/* Predictor                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Owns the predicted local {@link MoveState} and the unacknowledged input history.
 * Drive it once per frame with {@link record}, reconcile it once per snapshot with
 * {@link reconcile}, and read {@link predicted} (guarded by {@link hasBase}) to
 * overlay the local player's transform onto what the renderer draws.
 */
export class Predictor {
  /**
   * The current predicted kinematic state. Starts at the sim's standing-at-origin
   * default; it is meaningless (and {@link hasBase} stays `false`) until the first
   * {@link reconcile} anchors it to an authoritative server position.
   */
  private move: MoveState = createMoveState();

  /**
   * Inputs applied since the server's last ack, in ascending `seq` order (the
   * order {@link record} pushes them). Reconciliation drops the acked prefix and
   * replays the rest. Bounded in steady state because a reconcile lands on every
   * snapshot and prunes everything the server has processed.
   */
  private readonly history: RecordedInput[] = [];

  /** Whether {@link reconcile} has anchored us to an authoritative state yet. */
  private anchored = false;

  /* ---- Read surface ----------------------------------------------------- */

  /**
   * `true` once at least one {@link reconcile} has run, i.e. the predicted state is
   * anchored to a real server position and safe to render. While `false` the
   * render loop must leave the local entity on its interpolated value.
   */
  get hasBase(): boolean {
    return this.anchored;
  }

  /** The current predicted transform (a fresh object; never a live reference). */
  get predicted(): PredictedTransform {
    return { x: this.move.x, y: this.move.y, z: this.move.z, yaw: this.move.yaw };
  }

  /* ---- Prediction ------------------------------------------------------- */

  /**
   * The shared server pipeline for one input frame: advance the kinematics with
   * {@link step}, then resolve the resulting XZ against the town with
   * {@link collideCircleXZ} (keeping `y` exactly as the sim produced it). This is a
   * faithful mirror of `Room.integrate` so prediction tracks the authority.
   */
  private stepAndCollide(
    state: MoveState,
    keys: number,
    yaw: number,
    dt: number,
    world: World,
  ): MoveState {
    const n = step(state, { keys, yaw }, dt);
    const r = collideCircleXZ(world, n.x, n.z, PLAYER_RADIUS);
    return { ...n, x: r.x, z: r.z };
  }

  /**
   * Apply one freshly-sampled local input: remember it in the history (so a later
   * reconcile can replay it) and advance the predicted state immediately, so the
   * body moves on THIS frame rather than a round-trip later.
   *
   * @param seq   The sequence number `Connection.sendInput` assigned this frame.
   * @param keys  Held-key bitmask sent this frame.
   * @param yaw   Look yaw (radians) sent this frame.
   * @param dt    Frame delta in seconds.
   * @param world The seeded town, for XZ collision resolution.
   */
  record(seq: number, keys: number, yaw: number, dt: number, world: World): void {
    this.history.push({ seq, keys, yaw, dt });
    this.move = this.stepAndCollide(this.move, keys, yaw, dt, world);
  }

  /* ---- Reconciliation --------------------------------------------------- */

  /**
   * Reconcile against an authoritative snapshot. Rebuilds the predicted state's
   * base from the server's version of the LOCAL player, discards every input the
   * server has already processed (`seq <= ackSeq`), and replays the still-unacked
   * tail through {@link stepAndCollide} — leaving the prediction corrected yet
   * already ahead by the inputs still in flight.
   *
   * The base takes the server's authoritative `x/y/z/yaw` verbatim. `grounded` is
   * re-derived from the server `y` (matching the sim's ground clamp); `vy` is zero
   * when grounded and otherwise carried from the current prediction (the snapshot
   * doesn't carry velocity); `crawling` is likewise carried from the current
   * prediction — while grounded, replaying the unacked inputs re-derives it from
   * the held keys anyway.
   *
   * @param server The authoritative local transform from the latest snapshot.
   * @param ackSeq The last input `seq` the server reports having processed.
   * @param world  The seeded town, for XZ collision resolution during replay.
   */
  reconcile(server: PredictedTransform, ackSeq: number, world: World): void {
    const grounded = server.y <= GROUND_EPSILON;
    let state: MoveState = {
      x: server.x,
      y: server.y,
      z: server.z,
      yaw: server.yaw,
      vy: grounded ? 0 : this.move.vy,
      grounded,
      crawling: this.move.crawling,
    };

    // Discard the acked prefix (history is ascending by seq, so this is a
    // contiguous run from the front).
    let drop = 0;
    while (drop < this.history.length && this.history[drop].seq <= ackSeq) {
      drop += 1;
    }
    if (drop > 0) this.history.splice(0, drop);

    // Replay everything the server hasn't processed yet on top of the base.
    for (const input of this.history) {
      state = this.stepAndCollide(state, input.keys, input.yaw, input.dt, world);
    }

    this.move = state;
    this.anchored = true;
  }
}
