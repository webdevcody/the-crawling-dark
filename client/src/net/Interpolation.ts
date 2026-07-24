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
 * sampling the world a fixed delay ({@link INTERP_BUFFER_MS}) *in the past*.
 * Because we render slightly behind the freshest data, there is almost always a
 * snapshot on either side of the render time to interpolate between, which
 * turns discrete network updates into smooth continuous motion.
 *
 * The module is deliberately pure: it never reads the clock itself. The caller
 * supplies `clientNowMs` (a {@link performance.now} reading), which keeps the
 * sampler deterministic and trivially testable.
 */

import { INTERP_BUFFER_MS, type EntitySnapshot } from '@crawling-dark/shared';

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
 * stays flat regardless of session length. Floored at 1 s so a small
 * {@link INTERP_BUFFER_MS} never starves the buffer.
 */
const RETENTION_MS = Math.max(1000, INTERP_BUFFER_MS * 4);

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

/* -------------------------------------------------------------------------- */
/* SnapshotInterpolator                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Buffers recent snapshots (each tagged with the client receive time) and
 * samples them {@link INTERP_BUFFER_MS} in the past, interpolating between the
 * two straddling snapshots. Position lerps linearly; yaw uses shortest-arc.
 * Deliberately holds (never extrapolates) when the buffer is starved.
 */
export class SnapshotInterpolator {
  /**
   * Ring of buffered snapshots in ascending receive-time order. New snapshots
   * are appended; stale ones are pruned from the front in {@link push}.
   */
  private readonly buffer: TimedSnapshot[] = [];

  /**
   * Record a freshly received snapshot at client time `clientNowMs`
   * (a {@link performance.now} reading). The entity array is shallow-copied so
   * later mutation of the caller's array can't corrupt the buffer; the entities
   * themselves are treated as immutable and stored by reference.
   */
  push(entities: readonly EntitySnapshot[], clientNowMs: number): void {
    this.buffer.push({ t: clientNowMs, entities: entities.slice() });

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
   * interpolated entities keyed by id; `delayMs` defaults to
   * {@link INTERP_BUFFER_MS}.
   *
   * Edge behavior:
   *  - empty buffer → empty map;
   *  - render time at/behind the oldest snapshot → that snapshot verbatim (clamp);
   *  - render time at/ahead of the newest snapshot → newest verbatim (hold — we
   *    never extrapolate, so a starved buffer freezes rather than overshoots).
   */
  sample(clientNowMs: number, delayMs: number = INTERP_BUFFER_MS): Map<number, InterpolatedEntity> {
    const buf = this.buffer;
    const out = new Map<number, InterpolatedEntity>();
    if (buf.length === 0) return out;

    const renderTime = clientNowMs - delayMs;

    // Clamp behind the oldest buffered snapshot: hold on the earliest we have.
    const oldest = buf[0];
    if (renderTime <= oldest.t) {
      return snapshotToMap(oldest.entities);
    }

    // Starved ahead of the newest snapshot: hold the latest (no extrapolation).
    const newest = buf[buf.length - 1];
    if (renderTime >= newest.t) {
      return snapshotToMap(newest.entities);
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

    // Index B's entities so we can pair them with A's by id.
    const bById = new Map<number, EntitySnapshot>();
    for (const e of b.entities) bById.set(e.id, e);

    const seen = new Set<number>();

    // Entities present in BOTH A and B: interpolate transform between them.
    for (const ea of a.entities) {
      const eb = bById.get(ea.id);
      if (eb === undefined) continue; // departed by B — drop it.
      seen.add(ea.id);
      out.set(ea.id, {
        id: ea.id,
        kind: eb.kind,
        state: eb.state,
        x: lerp(ea.x, eb.x, alpha),
        y: lerp(ea.y, eb.y, alpha),
        z: lerp(ea.z, eb.z, alpha),
        yaw: ea.yaw + shortestAngle(ea.yaw, eb.yaw) * alpha,
      });
    }

    // Entities present only in B (just appeared): show them at B's values.
    for (const eb of b.entities) {
      if (seen.has(eb.id)) continue;
      out.set(eb.id, {
        id: eb.id,
        kind: eb.kind,
        state: eb.state,
        x: eb.x,
        y: eb.y,
        z: eb.z,
        yaw: eb.yaw,
      });
    }

    return out;
  }

  /** Drop all buffered snapshots (e.g. on reconnect, so stale ghosts vanish). */
  clear(): void {
    this.buffer.length = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Materialize a snapshot's entities into an {@link InterpolatedEntity} map. */
function snapshotToMap(
  entities: readonly EntitySnapshot[],
): Map<number, InterpolatedEntity> {
  const out = new Map<number, InterpolatedEntity>();
  for (const e of entities) {
    out.set(e.id, {
      id: e.id,
      kind: e.kind,
      state: e.state,
      x: e.x,
      y: e.y,
      z: e.z,
      yaw: e.yaw,
    });
  }
  return out;
}
