/**
 * Remote-entity interpolation for The Crawling Dark (M2 · t2f).
 *
 * The server broadcasts authoritative {@link EntitySnapshot}s at a coarse rate
 * ({@link SNAPSHOT_RATE}), far below the client's render frame rate, and those
 * snapshots arrive with jitter (and occasionally out of order or dropped). If
 * the renderer snapped meshes straight onto the newest snapshot every frame,
 * remote players would visibly stutter and teleport.
 *
 * {@link SnapshotInterpolator} fixes this by buffering recent snapshots — each
 * tagged with the client's local receive time — and, on each render frame,
 * sampling the world a short delay *in the past*. Because we render slightly
 * behind the freshest data, there is almost always a snapshot on either side of
 * the render time to interpolate between, which turns discrete network updates
 * into smooth continuous motion.
 *
 * That delay is **adaptive** (M8 · t8d). A fixed {@link INTERP_BUFFER_MS} works
 * on a calm link but stutters when jitter pushes a snapshot past the render
 * time. So {@link SnapshotInterpolator} measures inter-arrival jitter in
 * {@link SnapshotInterpolator.push} and grows/shrinks the delay within a clamped
 * band ({@link INTERP_DELAY_MIN_MS}…{@link INTERP_DELAY_MAX_MS}), slewing it
 * gently so the effective render clock never jerks. And when a snapshot is late
 * enough that the render time still overruns the newest sample, it briefly
 * *extrapolates* each body forward along its recent velocity (capped at
 * {@link INTERP_EXTRAPOLATION_CAP_MS}) instead of hard-freezing on the newest —
 * killing the old freeze-then-jump stutter. When the next snapshot lands, normal
 * interpolation resumes and naturally blends the extrapolated position back.
 *
 * The module is deliberately pure: it never reads the clock itself. The caller
 * supplies `clientNowMs` (a {@link performance.now} reading) to both `push` and
 * `sample`, which keeps the sampler deterministic and trivially testable.
 */

import {
  INTERP_BUFFER_MS,
  INTERP_DELAY_MIN_MS,
  INTERP_DELAY_MAX_MS,
  INTERP_EXTRAPOLATION_CAP_MS,
  SNAPSHOT_MS,
  type EntitySnapshot,
} from '@crawling-dark/shared';

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One entity's interpolated transform for a single render frame. Mirrors the
 * numeric fields of {@link EntitySnapshot}; `kind`/`state` are carried through
 * verbatim (they are discrete and never interpolated).
 */
export interface InterpolatedEntity {
  id: number;
  kind: EntitySnapshot['kind'];
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: EntitySnapshot['state'];
  /**
   * Sprint stamina fraction (0..1), mirrored straight from the snapshot. Lerped
   * between straddling snapshots like the positional fields so the HUD bar reads
   * as a smooth drain/regen rather than stepping at the snapshot cadence.
   */
  stamina: number;
}

/* -------------------------------------------------------------------------- */
/* Internal buffer entry                                                       */
/* -------------------------------------------------------------------------- */

/** One buffered snapshot, tagged with the client-local time it was received. */
interface TimedSnapshot {
  /** Client `performance.now()` timestamp at which this snapshot arrived. */
  t: number;
  /** The snapshot's entities (copied on push; treated as immutable). */
  entities: readonly EntitySnapshot[];
}

/* -------------------------------------------------------------------------- */
/* Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How long to retain snapshots, in milliseconds. A couple of buffer windows is
 * plenty to always straddle the render time; anything older is pruned so memory
 * stays flat regardless of session length. Sized off the *deepest* possible
 * adaptive delay ({@link INTERP_DELAY_MAX_MS}) rather than the base so even a
 * maximally-widened buffer keeps the straddling pair — plus the extra prior
 * sample the extrapolator needs for its velocity estimate — alive. Floored at
 * 1 s so a small band never starves the buffer.
 */
const RETENTION_MS = Math.max(1000, INTERP_DELAY_MAX_MS * 4);

/**
 * EMA smoothing factor for the jitter estimate updated in {@link SnapshotInterpolator.push}.
 * Each snapshot folds `abs(interArrival - SNAPSHOT_MS)` into the running average
 * by this weight. Low (≈0.1) on purpose: the estimate reflects *sustained* jitter
 * over the last ~10 snapshots (~0.7 s) rather than twitching on one late frame,
 * which keeps the derived delay — and therefore the render clock — steady.
 */
const JITTER_EMA_ALPHA = 0.1;

/**
 * Gain `k` on the smoothed jitter when deriving the target delay
 * (`target = INTERP_BUFFER_MS + k · jitter`, then clamped to the
 * {@link INTERP_DELAY_MIN_MS}…{@link INTERP_DELAY_MAX_MS} band). At 2× a
 * sustained 30–80 ms jitter lands the delay comfortably inside the band with
 * headroom to spare, so two snapshots keep straddling the render time even on a
 * choppy link. Larger values buy more safety margin at the cost of remote latency.
 */
const JITTER_DELAY_GAIN = 2;

/**
 * Maximum change (ms) applied to the effective delay per snapshot in
 * {@link SnapshotInterpolator.push}. The delay is slewed toward its target no
 * faster than this so the render clock (`clientNowMs - delay`) only ever
 * time-warps by a few ms per ~{@link SNAPSHOT_MS} — a handful of percent, below
 * the threshold of perception — instead of lurching when jitter jumps. At ~15
 * snapshots/s this converges across the full band in a couple of seconds.
 */
const DELAY_SLEW_MS_PER_UPDATE = 4;

/**
 * Pool-size ceiling before {@link SnapshotInterpolator} compacts its per-id
 * entity pool (M8 · t8e). The sampler reuses one {@link InterpolatedEntity} object
 * per id across frames so its hot path allocates nothing in steady state; but
 * entity ids increase monotonically as players join over a long session, so that
 * pool would otherwise creep upward as departed ids linger. Once it exceeds this
 * many entries the sampler drops any pooled object not emitted in the current
 * frame. Set well above a full 12-player room (+ the NPC) so a normal roster never
 * triggers a prune — it only fires after many join/leave cycles pile up dead ids.
 */
const POOL_PRUNE_THRESHOLD = 64;

/* -------------------------------------------------------------------------- */
/* Angle helper                                                                */
/* -------------------------------------------------------------------------- */

const TWO_PI = Math.PI * 2;

/**
 * Shortest signed angular difference from `a` to `b`, normalized to (-π, π].
 * Interpolating `a + shortestAngle(a, b) * alpha` always rotates the short way
 * around the circle, so a facing that crosses the ±π wrap (e.g. from 170° to
 * -170°) turns 20° rather than spinning 340° the wrong way.
 */
function shortestAngle(a: number, b: number): number {
  return ((b - a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
}

/** Linear interpolation between `a` and `b` by `alpha` in [0, 1]. */
function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

/** Clamp `v` into the inclusive range [`min`, `max`]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/* -------------------------------------------------------------------------- */
/* SnapshotInterpolator                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Buffers recent snapshots (each tagged with the client receive time) and
 * samples them a short, jitter-adaptive delay in the past, interpolating between
 * the two straddling snapshots. Position lerps linearly; yaw uses shortest-arc.
 * When a late snapshot leaves the render time past the newest sample it
 * extrapolates each body forward along its recent velocity for a bounded time
 * ({@link INTERP_EXTRAPOLATION_CAP_MS}) rather than freezing on the newest.
 */
export class SnapshotInterpolator {
  /**
   * Ring of buffered snapshots in ascending receive-time order. New snapshots
   * are appended; stale ones are pruned from the front in {@link push}.
   */
  private readonly buffer: TimedSnapshot[] = [];

  /**
   * Client receive time of the previous {@link push}, or `undefined` before the
   * first snapshot / after {@link clear}. Used to measure inter-arrival gaps for
   * the jitter estimate; `undefined` means "no gap to measure yet".
   */
  private lastArrivalMs: number | undefined = undefined;

  /**
   * Smoothed jitter estimate (ms): an EMA of `abs(interArrival - SNAPSHOT_MS)`.
   * Zero on a perfectly paced stream; grows as arrivals bunch up or stretch out.
   * Drives the adaptive delay. Reset to 0 in {@link clear}.
   */
  private jitterMs = 0;

  /**
   * The current effective sample delay (ms) used when {@link sample} is called
   * without an explicit `delayMs`. Seeded at {@link INTERP_BUFFER_MS} and slewed
   * gently toward `INTERP_BUFFER_MS + JITTER_DELAY_GAIN · jitterMs` (clamped to
   * the {@link INTERP_DELAY_MIN_MS}…{@link INTERP_DELAY_MAX_MS} band) on each
   * {@link push}. Reset to the seed in {@link clear}.
   */
  private adaptiveDelayMs = INTERP_BUFFER_MS;

  /* ---- Per-frame reuse (M8 · t8e allocation cleanup) -------------------- */

  /**
   * The map returned by {@link sample}, reused every frame (cleared, then
   * repopulated) so the sample hot path allocates no fresh map per render frame.
   * It is OWNED by this instance and overwritten on the next {@link sample};
   * callers must consume it within the frame and never retain it across frames
   * (main.ts does exactly this).
   */
  private readonly out = new Map<number, InterpolatedEntity>();

  /**
   * Per-id pool of {@link InterpolatedEntity} objects, reused across frames and
   * mutated in place by {@link emit} instead of allocating a fresh object per
   * entity per frame. Bounded by {@link finishFrame}'s compaction against
   * {@link POOL_PRUNE_THRESHOLD}.
   */
  private readonly pool = new Map<number, InterpolatedEntity>();

  /**
   * Scratch id→snapshot index reused by {@link sample}/{@link extrapolateInto} to
   * pair the two straddling snapshots by id without allocating a fresh Map each
   * call. Cleared before every use, so its contents never leak between calls.
   */
  private readonly scratchById = new Map<number, EntitySnapshot>();

  /**
   * Record a freshly received snapshot at client time `clientNowMs`
   * (a {@link performance.now} reading). The entity array is shallow-copied so
   * later mutation of the caller's array can't corrupt the buffer; the entities
   * themselves are treated as immutable and stored by reference.
   */
  push(entities: readonly EntitySnapshot[], clientNowMs: number): void {
    this.buffer.push({ t: clientNowMs, entities: entities.slice() });

    // --- Adapt the interpolation delay to measured inter-arrival jitter. ---
    // `clientNowMs` comes from monotonic performance.now(), so successive pushes
    // are non-decreasing; guard against a zero/negative gap defensively.
    if (this.lastArrivalMs !== undefined) {
      const interArrival = clientNowMs - this.lastArrivalMs;
      if (interArrival > 0) {
        // How far this gap strayed from the ideal snapshot cadence.
        const deviation = Math.abs(interArrival - SNAPSHOT_MS);
        this.jitterMs += JITTER_EMA_ALPHA * (deviation - this.jitterMs);

        // Target = base + k·jitter, clamped into the straddle-safe band.
        const target = clamp(
          INTERP_BUFFER_MS + JITTER_DELAY_GAIN * this.jitterMs,
          INTERP_DELAY_MIN_MS,
          INTERP_DELAY_MAX_MS,
        );

        // Slew gently toward the target so the render clock never jerks.
        const step = clamp(
          target - this.adaptiveDelayMs,
          -DELAY_SLEW_MS_PER_UPDATE,
          DELAY_SLEW_MS_PER_UPDATE,
        );
        this.adaptiveDelayMs += step;
      }
    }
    this.lastArrivalMs = clientNowMs;

    // Prune anything older than the retention window so memory stays flat.
    const cutoff = clientNowMs - RETENTION_MS;
    let drop = 0;
    while (drop < this.buffer.length && this.buffer[drop].t < cutoff) {
      drop += 1;
    }
    if (drop > 0) this.buffer.splice(0, drop);
  }

  /**
   * Sample the buffered world at (`clientNowMs` - `delayMs`), interpolating
   * between the two snapshots that straddle that render time. Returns the
   * interpolated entities keyed by id.
   *
   * `delayMs` is optional: when omitted, the current *adaptive* delay is used
   * (jitter-tracked in {@link push}, seeded from {@link INTERP_BUFFER_MS} and
   * clamped to the {@link INTERP_DELAY_MIN_MS}…{@link INTERP_DELAY_MAX_MS} band).
   * When supplied it is honored verbatim, so callers that want a fixed delay
   * still get one (backward compatible).
   *
   * Edge behavior:
   *  - empty buffer → empty map;
   *  - render time at/behind the oldest snapshot → that snapshot verbatim (clamp);
   *  - render time at/ahead of the newest snapshot → **bounded extrapolation**:
   *    each body is projected forward along the velocity implied by the two most
   *    recent snapshots for up to {@link INTERP_EXTRAPOLATION_CAP_MS}, then holds
   *    (it never flies off, and entities with no prior sample simply hold).
   */
  sample(clientNowMs: number, delayMs?: number): Map<number, InterpolatedEntity> {
    // Reuse the output map across frames (M8 · t8e): clear it, repopulate via
    // {@link emit}, and hand the same instance back — no per-frame map/object
    // churn. Every return path below funnels through {@link finishFrame}.
    this.out.clear();

    const buf = this.buffer;
    if (buf.length === 0) return this.out;

    const delay = delayMs ?? this.adaptiveDelayMs;
    const renderTime = clientNowMs - delay;

    // Clamp behind the oldest buffered snapshot: hold on the earliest we have.
    const oldest = buf[0];
    if (renderTime <= oldest.t) {
      return this.hold(oldest.entities);
    }

    // Ahead of the newest snapshot (a late/dropped frame): extrapolate forward a
    // bounded amount from recent velocity instead of freezing on the newest.
    const newest = buf[buf.length - 1];
    if (renderTime >= newest.t) {
      const prev = buf.length >= 2 ? buf[buf.length - 2] : undefined;
      return this.extrapolateInto(newest, prev, renderTime - newest.t);
    }

    // Find adjacent snapshots A (t <= renderTime) and B (t > renderTime).
    // A linear scan is fine: the buffer holds only ~1 s of snapshots.
    let aIndex = 0;
    for (let i = 1; i < buf.length; i += 1) {
      if (buf[i].t > renderTime) break;
      aIndex = i;
    }
    const a = buf[aIndex];
    const b = buf[aIndex + 1];

    const span = b.t - a.t;
    // Guard against coincident timestamps; clamp alpha into [0, 1] for safety.
    const alpha = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.t) / span)) : 0;

    // Index B's entities (reused scratch) so we can pair them with A's by id.
    const bById = this.scratchById;
    bById.clear();
    for (const e of b.entities) bById.set(e.id, e);

    // Entities present in BOTH A and B: interpolate transform between them.
    for (const ea of a.entities) {
      const eb = bById.get(ea.id);
      if (eb === undefined) continue; // departed by B — drop it.
      this.emit(
        ea.id,
        eb.kind,
        eb.state,
        lerp(ea.x, eb.x, alpha),
        lerp(ea.y, eb.y, alpha),
        lerp(ea.z, eb.z, alpha),
        ea.yaw + shortestAngle(ea.yaw, eb.yaw) * alpha,
        lerp(ea.stamina, eb.stamina, alpha),
      );
    }

    // Entities present only in B (just appeared): show them at B's values. Those
    // already emitted from the A∩B pass are skipped via the output map itself, so
    // no separate `seen` set is needed.
    for (const eb of b.entities) {
      if (this.out.has(eb.id)) continue;
      this.emit(eb.id, eb.kind, eb.state, eb.x, eb.y, eb.z, eb.yaw, eb.stamina);
    }

    return this.finishFrame();
  }

  /* ---- Reused-map population (M8 · t8e) --------------------------------- */

  /**
   * Stage one entity into the reused {@link out} map for this frame, reusing the
   * pooled {@link InterpolatedEntity} for `id` (mutated in place) or creating and
   * pooling a fresh one on first sight. No allocation once an id's object exists.
   */
  private emit(
    id: number,
    kind: EntitySnapshot['kind'],
    state: EntitySnapshot['state'],
    x: number,
    y: number,
    z: number,
    yaw: number,
    stamina: number,
  ): void {
    let e = this.pool.get(id);
    if (e === undefined) {
      e = { id, kind, state, x, y, z, yaw, stamina };
      this.pool.set(id, e);
    } else {
      e.kind = kind;
      e.state = state;
      e.x = x;
      e.y = y;
      e.z = z;
      e.yaw = yaw;
      e.stamina = stamina;
    }
    this.out.set(id, e);
  }

  /** Emit every entity verbatim (the clamp/hold path), then finish the frame. */
  private hold(entities: readonly EntitySnapshot[]): Map<number, InterpolatedEntity> {
    for (const e of entities) {
      this.emit(e.id, e.kind, e.state, e.x, e.y, e.z, e.yaw, e.stamina);
    }
    return this.finishFrame();
  }

  /**
   * Return the populated {@link out} map, first compacting the reuse {@link pool}
   * if it has grown well past the live roster (see {@link POOL_PRUNE_THRESHOLD}) —
   * dropping any pooled object not emitted this frame so a long session's
   * monotonically-growing ids can't leak memory. Deleting during Map iteration is
   * safe in JS. The steady-state roster stays under the threshold, so this is a
   * no-op on the normal path.
   */
  private finishFrame(): Map<number, InterpolatedEntity> {
    if (this.pool.size > POOL_PRUNE_THRESHOLD && this.pool.size > this.out.size) {
      for (const id of this.pool.keys()) {
        if (!this.out.has(id)) this.pool.delete(id);
      }
    }
    return this.out;
  }

  /**
   * Project the `newest` snapshot `aheadMs` past its own timestamp into the reused
   * {@link out} map, using the per-entity velocity implied by the previous
   * snapshot `prev`. Only POSITION (x/y/z) is extrapolated; `kind`/`state`/`yaw`/
   * `stamina` are held at their newest values — rotation and gameplay state should
   * not be guessed, and holding them is imperceptible over the short window.
   *
   * The projection time is clamped to {@link INTERP_EXTRAPOLATION_CAP_MS}, so once
   * `aheadMs` exceeds the cap the body stops advancing and holds at the last
   * projected point rather than flying off. Entities present only in `newest` (no
   * prior sample), and the degenerate cases where there is no prior snapshot or the
   * two share a timestamp, all fall back to holding `newest` verbatim. When the
   * next snapshot lands, ordinary interpolation resumes and blends the projected
   * position back toward authoritative state.
   */
  private extrapolateInto(
    newest: TimedSnapshot,
    prev: TimedSnapshot | undefined,
    aheadMs: number,
  ): Map<number, InterpolatedEntity> {
    const dtExtrap = Math.min(aheadMs, INTERP_EXTRAPOLATION_CAP_MS);

    // No prior sample, coincident timestamps, or nothing to project: just hold.
    const dt = prev !== undefined ? newest.t - prev.t : 0;
    if (prev === undefined || dt <= 0 || dtExtrap <= 0) {
      return this.hold(newest.entities);
    }

    const prevById = this.scratchById;
    prevById.clear();
    for (const e of prev.entities) prevById.set(e.id, e);

    for (const e of newest.entities) {
      const p = prevById.get(e.id);
      if (p === undefined) {
        // New this snapshot — no velocity to derive, so hold at newest.
        this.emit(e.id, e.kind, e.state, e.x, e.y, e.z, e.yaw, e.stamina);
        continue;
      }
      // Velocity from the two most recent samples, projected forward dtExtrap.
      this.emit(
        e.id,
        e.kind,
        e.state,
        e.x + ((e.x - p.x) / dt) * dtExtrap,
        e.y + ((e.y - p.y) / dt) * dtExtrap,
        e.z + ((e.z - p.z) / dt) * dtExtrap,
        e.yaw,
        e.stamina,
      );
    }
    return this.finishFrame();
  }

  /**
   * Drop all buffered snapshots (e.g. on reconnect, so stale ghosts vanish) and
   * reset the jitter/arrival tracking so the adaptive delay starts fresh from its
   * seed — a reconnected stream re-learns its own jitter rather than inheriting
   * the pre-drop estimate.
   */
  clear(): void {
    this.buffer.length = 0;
    this.lastArrivalMs = undefined;
    this.jitterMs = 0;
    this.adaptiveDelayMs = INTERP_BUFFER_MS;
    // Drop the reuse map + pool so a reconnect starts with no stale objects.
    this.out.clear();
    this.pool.clear();
  }
}
