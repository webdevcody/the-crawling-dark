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
 *   3. RECONCILE — when an authoritative snapshot arrives, rebuild the predicted
 *      state from the server's version of the local player, discard every input the
 *      server has already processed (`seq <= ack`), and re-apply the
 *      still-unacknowledged tail. The result is a corrected prediction that
 *      already accounts for inputs in flight, so the correction is invisible under
 *      normal latency (no rubber-band). Rather than hard-SNAP the render transform
 *      onto that correction — which pops visibly under packet jitter/loss — the
 *      residual position error is folded into a persistent render {@link offset}
 *      that decays to zero over a few frames (M8 · t8b), so the body slides onto
 *      the authority instead of jumping. A genuinely large correction (a
 *      teleport/respawn past {@link SNAP_DIST}) skips smoothing and snaps at once.
 *
 * The whole scheme hinges on the client and server running BYTE-FOR-BYTE identical
 * math: this module deliberately reuses the shared, pure {@link step} and
 * {@link collideCircleXZ} rather than reimplementing movement, and mirrors the
 * server's ordering (`step` first, then resolve XZ against the town — see
 * `Room.integrate`). Because the caller now pumps {@link record} on the SAME fixed
 * timestep the server integrates (`dt = TICK_MS/1000`, M8 · t8a) instead of the
 * old variable per-frame `dt`, the prediction no longer drifts between reconciles;
 * what tiny error remains (from packets in flight, loss, or a clamped catch-up) is
 * the sub-metre correction the render {@link offset} smooths away.
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

/**
 * Half-life (ms) of the render error-smoothing {@link Predictor.offset} (M8 · t8b).
 * On each reconcile the sub-threshold correction is folded into `offset` and then
 * decayed toward zero once per RENDER frame via {@link Predictor.decayOffset} as
 * `offset *= 0.5 ** (dtMs / OFFSET_HALF_LIFE_MS)`. At ~45 ms the offset is ~75 %
 * gone in one 60 fps frame-pair and visually settled inside ~5–8 frames — long
 * enough that a correction glides rather than pops, short enough that the rendered
 * body never lags perceptibly behind the authoritative prediction. Framerate-
 * independent by construction, so 30/60/144 fps all resolve over the same wall-clock.
 */
const OFFSET_HALF_LIFE_MS = 45;

/**
 * Correction magnitude (meters, on the 3D positional error) at or above which a
 * reconcile is treated as a genuine teleport/respawn rather than a normal
 * prediction correction, and the render {@link Predictor.offset} is reset to zero
 * so the body SNAPS to the new authority instantly (M8 · t8b). Sub-threshold
 * errors smooth; a real relocation (respawn as a zombie, forced move) never
 * "slides" the whole way across the map. Sized well above the sub-metre errors
 * normal latency/jitter produce yet below any real teleport distance.
 */
const SNAP_DIST = 1.75;

/**
 * Per-axis magnitude below which the residual {@link Predictor.offset} is clamped
 * to exactly zero during decay. The exponential decay only ever approaches zero
 * asymptotically; this floor stops a vanishing sub-micrometre offset from riding
 * the rendered transform forever (and lets the render loop's cheap add short-out).
 */
const OFFSET_EPSILON = 1e-4;

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

  /**
   * Persistent render error-smoothing offset (M8 · t8b), in meters per axis. It is
   * ADDED to the predicted position by {@link predicted} but never influences the
   * simulated {@link move} state itself (prediction/replay stay byte-exact with the
   * server). {@link reconcile} folds each sub-threshold correction into it so the
   * rendered body stays put across the reconcile frame; {@link decayOffset} bleeds
   * it back toward zero every render frame so the body then glides onto the
   * authority. `yaw` is deliberately NOT smoothed (the server trusts client yaw, so
   * yaw error is ~0) — this is position-only.
   */
  private readonly offset = { x: 0, y: 0, z: 0 };

  /* ---- Read surface ----------------------------------------------------- */

  /**
   * `true` once at least one {@link reconcile} has run, i.e. the predicted state is
   * anchored to a real server position and safe to render. While `false` the
   * render loop must leave the local entity on its interpolated value.
   */
  get hasBase(): boolean {
    return this.anchored;
  }

  /**
   * The current predicted transform (a fresh object; never a live reference),
   * with the render error-smoothing {@link offset} already folded into position
   * (M8 · t8b). `yaw` is returned exact (unsmoothed). The render loop reads this
   * AFTER advancing the decay for the frame via {@link decayOffset}.
   */
  get predicted(): PredictedTransform {
    return {
      x: this.move.x + this.offset.x,
      y: this.move.y + this.offset.y,
      z: this.move.z + this.offset.z,
      yaw: this.move.yaw,
    };
  }

  /* ---- Render error smoothing (M8 · t8b) -------------------------------- */

  /**
   * Advance the reconciliation {@link offset}'s decay by one RENDER frame, called
   * once per frame by the render loop (the fixed-timestep prediction sub-steps no
   * longer run every frame, so decay can't be folded into {@link record}). Uses a
   * framerate-independent exponential toward zero — `offset *= 0.5 ** (dtMs /
   * {@link OFFSET_HALF_LIFE_MS})` — so the smoothing settles over the same
   * wall-clock at any frame rate. Once every axis falls under {@link OFFSET_EPSILON}
   * the offset is clamped to exactly zero. A non-positive `dtMs` is a no-op.
   */
  decayOffset(dtMs: number): void {
    if (dtMs <= 0) return;
    const factor = 0.5 ** (dtMs / OFFSET_HALF_LIFE_MS);
    this.offset.x *= factor;
    this.offset.y *= factor;
    this.offset.z *= factor;
    if (
      Math.abs(this.offset.x) < OFFSET_EPSILON &&
      Math.abs(this.offset.y) < OFFSET_EPSILON &&
      Math.abs(this.offset.z) < OFFSET_EPSILON
    ) {
      this.offset.x = 0;
      this.offset.y = 0;
      this.offset.z = 0;
    }
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
   * Before the predicted state is overwritten, the OLD predicted position is
   * captured; after the corrected state is rebuilt, the per-axis error
   * (`oldPredicted - newCorrected`) is FOLDED into the render {@link offset} so the
   * rendered transform (`corrected + offset`) is unchanged across this frame — the
   * correction is applied to the sim but not shown as a jump, then {@link
   * decayOffset} bleeds it away over the next few frames (M8 · t8b). A correction
   * whose magnitude reaches {@link SNAP_DIST} — a real teleport/respawn — resets the
   * offset to zero instead, snapping instantly. The first anchor also snaps (there
   * is no meaningful "previous" render position to preserve yet).
   *
   * @param server The authoritative local transform from the latest snapshot.
   * @param ackSeq The last input `seq` the server reports having processed.
   * @param world  The seeded town, for XZ collision resolution during replay.
   */
  reconcile(server: PredictedTransform, ackSeq: number, world: World): void {
    // Capture the OLD predicted position before we rebuild `move`, so the render
    // offset can absorb the correction and keep the drawn body continuous (t8b).
    const wasAnchored = this.anchored;
    const prevX = this.move.x;
    const prevY = this.move.y;
    const prevZ = this.move.z;

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

    // Fold the positional correction into the render offset so `predicted`
    // (corrected + offset) is unchanged across this reconcile frame — no pop. A
    // genuinely large correction (teleport/respawn) or the very first anchor snaps
    // instead: zero the offset and let the body land on the authority at once.
    const ex = prevX - state.x;
    const ey = prevY - state.y;
    const ez = prevZ - state.z;
    if (!wasAnchored || Math.hypot(ex, ey, ez) >= SNAP_DIST) {
      this.offset.x = 0;
      this.offset.y = 0;
      this.offset.z = 0;
    } else {
      this.offset.x += ex;
      this.offset.y += ey;
      this.offset.z += ez;
    }
  }
}
