/**
 * Binary snapshot codec for The Crawling Dark (M7 · t7a + t7b).
 *
 * SNAPSHOT frames are by far the highest-bandwidth traffic on the wire — they
 * ship every tracked entity, {@link SNAPSHOT_RATE} times a second, to every
 * client. JSON is fine for the sparse, human-readable control messages
 * (JOIN/WELCOME/ROUND/PONG/EVENT) but wastes ~10x the bytes on the dense,
 * purely-numeric snapshot stream. This module packs one snapshot into a tight
 * quantized {@link ArrayBuffer} instead:
 *
 *   - X / Z         → uint16 over the {@link MAP_SIZE}-wide world (~2 mm steps)
 *   - Y             → uint16 over a small vertical band (see {@link Y_MIN}/{@link Y_MAX})
 *   - yaw           → uint16 over `[0, 2π)` (~0.006° steps, wrapping)
 *   - state         → 1 byte (enumerated in {@link STATE_CODES})
 *   - kind          → 1 bit, packed into the state byte
 *   - stamina       → 1 byte (`0..1` → `0..255`)
 *   - id            → uint16 (see the ≤65535 ids/room assumption below)
 *
 * That is a flat **12 bytes per entity** versus ~120 bytes of JSON, well within
 * quantization tolerance for gameplay (positions land inside a couple of
 * millimetres, yaw inside a hundredth of a degree — invisible after the client
 * interpolates). ONLY snapshots use this path; every other message stays JSON
 * text. The {@link SNAPSHOT_WIRE} flag flips both sides back to JSON when a
 * readable stream is wanted for debugging.
 *
 * t7b layers delta compression on top: {@link encodeSnapshotBinary} also accepts
 * a {@link DeltaSnapshot} (only the entities that changed since a client-ACKed
 * baseline, plus the ids that left), and {@link decodeSnapshotBinary} reports
 * whether the frame it read was a full or a delta so the client can rebuild the
 * world against the right baseline.
 *
 * ── Assumptions / limits ─────────────────────────────────────────────────
 *   • Entity `id` is transmitted as an unsigned 16-bit int, so a single room
 *     may allocate at most 65535 distinct ids over its lifetime. Ids are never
 *     reused in a room and grow by ≤ {@link MAX_PLAYERS} per round, so this is
 *     ~5k rounds of headroom — ample, but worth knowing before wiring in a
 *     never-restarting server. Ids beyond the cap would wrap and collide.
 *   • `tick` and `ack` are uint32 (years of headroom at our rates).
 *   • Endianness is fixed little-endian on both sides.
 */

import { MAP_SIZE } from './constants';
import { MessageType } from './protocol';
import type {
  EntityKind,
  EntitySnapshot,
  EntityState,
  EventKind,
  GameEvent,
  SnapshotMessage,
} from './protocol';

/* -------------------------------------------------------------------------- */
/* Quantization ranges                                                        */
/* -------------------------------------------------------------------------- */

/** Lowest world coordinate on the X/Z axes (the map spans `[-MAP_SIZE/2, +MAP_SIZE/2]`). */
const XZ_MIN = -MAP_SIZE / 2;
/** Full span of the X/Z world range, in meters. */
const XZ_SPAN = MAP_SIZE;

/**
 * Vertical quantization band, in meters. Ground sits at `y = 0`; a jump peaks
 * around `+1.2 m` and terrain never dips below the street, so `[-4, 16]` leaves
 * generous head- and foot-room while keeping the 16-bit Y resolution at a sub-
 * millimetre `20 / 65535 ≈ 0.3 mm`. Positions outside the band clamp to it.
 */
const Y_MIN = -4;
const Y_MAX = 16;
const Y_SPAN = Y_MAX - Y_MIN;

/** `2π`; yaw is quantized as a fraction of a full turn so it wraps cleanly. */
const TWO_PI = Math.PI * 2;

/** Largest value a uint16 field can hold (the quantization denominator). */
const U16_MAX = 0xffff;

/* -------------------------------------------------------------------------- */
/* Enum <-> byte tables                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Stable wire ordering of the {@link EntityState} union. The INDEX is the byte
 * written on the wire, so entries may only ever be APPENDED — never reordered
 * or removed — or old/new builds would disagree on what a state byte means.
 */
const STATE_CODES: readonly EntityState[] = [
  'idle', // 0
  'walk', // 1
  'run', // 2
  'crawl', // 3
  'jump', // 4
  'attack', // 5
  'stun', // 6
  'down', // 7
];

/** Reverse lookup: {@link EntityState} → its wire byte. */
const STATE_TO_CODE: Record<EntityState, number> = STATE_CODES.reduce(
  (acc, state, code) => {
    acc[state] = code;
    return acc;
  },
  {} as Record<EntityState, number>,
);

/**
 * Stable wire ordering of the {@link EventKind} union (append-only, as above).
 * Events ride inside snapshots, so they are packed here rather than in JSON.
 */
const EVENT_CODES: readonly EventKind[] = [
  'attack', // 0
  'infect', // 1
  'stun', // 2
  'jump', // 3
  'roundStart', // 4
  'roundEnd', // 5
];

/** Reverse lookup: {@link EventKind} → its wire byte. */
const EVENT_TO_CODE: Record<EventKind, number> = EVENT_CODES.reduce(
  (acc, kind, code) => {
    acc[kind] = code;
    return acc;
  },
  {} as Record<EventKind, number>,
);

/** `kind` is a single bit in the state byte: `0` = human, `1` = zombie. */
const KIND_ZOMBIE_BIT = 0x80;

/* -------------------------------------------------------------------------- */
/* Frame layout                                                               */
/* -------------------------------------------------------------------------- */

/** Wire format version, packed into the high nibble of the flags byte. */
const WIRE_VERSION = 1;

/** Flags byte: bit0 marks a delta frame, bits4-7 carry {@link WIRE_VERSION}. */
const FLAG_DELTA = 0x01;

/** Fixed byte cost of one encoded entity record (see the field breakdown above). */
const ENTITY_BYTES = 12;

/** Event presence bits (which optional {@link GameEvent} fields follow). */
const EV_HAS_ACTOR = 0x01;
const EV_HAS_TARGET = 0x02;
const EV_HAS_POS = 0x04;

/* -------------------------------------------------------------------------- */
/* Public shapes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A delta snapshot: the same header as a {@link SnapshotMessage} plus a
 * `baselineTick` (the earlier, client-ACKed snapshot this diff is measured
 * against), `entities` narrowed to only those added-or-changed since that
 * baseline, and the `removed` ids that were present in the baseline but are
 * gone now (an entity that left interest, disconnected, or was culled). The
 * receiver reconstructs the full world by applying this onto its stored
 * baseline state.
 */
export interface DeltaSnapshot {
  t: typeof MessageType.Snapshot;
  tick: number;
  ack: number;
  /** The tick of the baseline snapshot this delta is diffed against. */
  baselineTick: number;
  /** Entities added or changed since {@link baselineTick}. */
  entities: EntitySnapshot[];
  /** Ids present at {@link baselineTick} but absent now. */
  removed: number[];
  events?: GameEvent[];
}

/**
 * The result of {@link decodeSnapshotBinary}. `isDelta` selects how the client
 * rebuilds the world: a full frame REPLACES its state, a delta frame is APPLIED
 * onto the baseline it stored for {@link baselineTick} (`entities` set/added,
 * {@link removed} deleted). `baselineTick` is `-1` for a full frame.
 */
export interface DecodedSnapshot {
  isDelta: boolean;
  tick: number;
  ack: number;
  baselineTick: number;
  /** Full frame: every entity. Delta frame: only the added/changed entities. */
  entities: EntitySnapshot[];
  /** Delta frame only: ids removed since the baseline (empty for a full frame). */
  removed: number[];
  events: GameEvent[];
}

/* -------------------------------------------------------------------------- */
/* Scalar quantizers                                                          */
/* -------------------------------------------------------------------------- */

/** Clamp `v` into `[lo, hi]`. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** X/Z meters → uint16 over the map range. */
function quantXZ(v: number): number {
  return clamp(Math.round(((v - XZ_MIN) / XZ_SPAN) * U16_MAX), 0, U16_MAX);
}
/** uint16 → X/Z meters. */
function dequantXZ(u: number): number {
  return XZ_MIN + (u / U16_MAX) * XZ_SPAN;
}

/** Y meters → uint16 over the vertical band. */
function quantY(v: number): number {
  return clamp(Math.round(((v - Y_MIN) / Y_SPAN) * U16_MAX), 0, U16_MAX);
}
/** uint16 → Y meters. */
function dequantY(u: number): number {
  return Y_MIN + (u / U16_MAX) * Y_SPAN;
}

/** yaw radians → uint16 over `[0, 2π)` (65536 steps, wrapping). */
function quantYaw(v: number): number {
  let a = v % TWO_PI;
  if (a < 0) a += TWO_PI;
  // 65536 divisions so a full turn wraps back to 0; mask handles the round-up.
  return Math.round((a / TWO_PI) * 65536) & U16_MAX;
}
/** uint16 → yaw radians in `[0, 2π)`. */
function dequantYaw(u: number): number {
  return (u / 65536) * TWO_PI;
}

/** stamina fraction `0..1` → uint8 `0..255`. */
function quantStamina(v: number): number {
  return clamp(Math.round(v * 255), 0, 255);
}
/** uint8 `0..255` → stamina fraction `0..1`. */
function dequantStamina(u: number): number {
  return u / 255;
}

/* -------------------------------------------------------------------------- */
/* Delta diffing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * True when two entity snapshots are indistinguishable AFTER quantization —
 * i.e. they encode to identical bytes. Diffing at the quantized granularity
 * (not on the raw floats) means an entity whose motion is smaller than a
 * quantization step is treated as unchanged and dropped from the delta, so
 * idle/near-idle entities cost nothing.
 */
function encodedEntityEqual(a: EntitySnapshot, b: EntitySnapshot): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.state === b.state &&
    quantXZ(a.x) === quantXZ(b.x) &&
    quantY(a.y) === quantY(b.y) &&
    quantXZ(a.z) === quantXZ(b.z) &&
    quantYaw(a.yaw) === quantYaw(b.yaw) &&
    quantStamina(a.stamina) === quantStamina(b.stamina)
  );
}

/**
 * Diff a `current` entity set against a `baseline` set, both already interest-
 * culled for the same client. Returns the entities to transmit (added or
 * meaningfully changed) and the ids to drop (present in the baseline, gone now).
 * The server feeds this into a {@link DeltaSnapshot}; the client applies the
 * inverse onto its stored baseline.
 */
export function diffSnapshots(
  baseline: readonly EntitySnapshot[],
  current: readonly EntitySnapshot[],
): { changed: EntitySnapshot[]; removed: number[] } {
  const baseById = new Map<number, EntitySnapshot>();
  for (const e of baseline) baseById.set(e.id, e);

  const changed: EntitySnapshot[] = [];
  const currentIds = new Set<number>();
  for (const e of current) {
    currentIds.add(e.id);
    const prev = baseById.get(e.id);
    if (prev === undefined || !encodedEntityEqual(prev, e)) changed.push(e);
  }

  const removed: number[] = [];
  for (const e of baseline) {
    if (!currentIds.has(e.id)) removed.push(e.id);
  }

  return { changed, removed };
}

/* -------------------------------------------------------------------------- */
/* Byte sizing                                                                */
/* -------------------------------------------------------------------------- */

/** Byte cost of one encoded {@link GameEvent} (variable: optional fields). */
function eventByteLength(ev: GameEvent): number {
  let n = 2; // kind code + presence byte
  if (ev.actorId !== undefined) n += 2;
  if (ev.targetId !== undefined) n += 2;
  if (ev.x !== undefined || ev.y !== undefined || ev.z !== undefined) n += 12;
  return n;
}

/* -------------------------------------------------------------------------- */
/* Encode                                                                     */
/* -------------------------------------------------------------------------- */

/** A `DeltaSnapshot` is distinguished from a full one by its `baselineTick`. */
function isDeltaFrame(
  frame: SnapshotMessage | DeltaSnapshot,
): frame is DeltaSnapshot {
  return typeof (frame as DeltaSnapshot).baselineTick === 'number';
}

/**
 * Encode a snapshot (full {@link SnapshotMessage} or {@link DeltaSnapshot}) into
 * a compact binary {@link ArrayBuffer} ready to hand straight to `socket.send`.
 * The frame is self-describing: {@link decodeSnapshotBinary} reads the flags
 * byte to tell full from delta.
 *
 * Layout (little-endian):
 * ```
 *   u8   flags            bit0 = isDelta, bits4-7 = WIRE_VERSION
 *   u32  tick
 *   u32  ack
 *  [u32  baselineTick]    delta frames only
 *   u16  entityCount
 *  [u16  removedCount]    delta frames only
 *   u16  eventCount
 *   entityCount × 12B entity records
 *  [removedCount × u16 ids]   delta frames only
 *   eventCount × variable event records
 * ```
 */
export function encodeSnapshotBinary(
  frame: SnapshotMessage | DeltaSnapshot,
): ArrayBuffer {
  const delta = isDeltaFrame(frame);
  const entities = frame.entities;
  const removed = delta ? frame.removed : [];
  const events = frame.events ?? [];

  // 1) Pre-compute the exact byte length so the buffer is sized to the frame.
  let bytes = 1 + 4 + 4 + 2 + 2; // flags + tick + ack + entityCount + eventCount
  if (delta) bytes += 4 + 2; // baselineTick + removedCount
  bytes += entities.length * ENTITY_BYTES;
  bytes += removed.length * 2;
  for (const ev of events) bytes += eventByteLength(ev);

  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);
  let off = 0;

  // 2) Header.
  view.setUint8(off, (WIRE_VERSION << 4) | (delta ? FLAG_DELTA : 0));
  off += 1;
  view.setUint32(off, frame.tick >>> 0, true);
  off += 4;
  view.setUint32(off, frame.ack >>> 0, true);
  off += 4;
  if (delta) {
    view.setUint32(off, frame.baselineTick >>> 0, true);
    off += 4;
  }
  view.setUint16(off, entities.length, true);
  off += 2;
  if (delta) {
    view.setUint16(off, removed.length, true);
    off += 2;
  }
  view.setUint16(off, events.length, true);
  off += 2;

  // 3) Entity records.
  for (const e of entities) {
    view.setUint16(off, e.id, true);
    view.setUint16(off + 2, quantXZ(e.x), true);
    view.setUint16(off + 4, quantY(e.y), true);
    view.setUint16(off + 6, quantXZ(e.z), true);
    view.setUint16(off + 8, quantYaw(e.yaw), true);
    const stateByte =
      (STATE_TO_CODE[e.state] ?? 0) | (e.kind === 'zombie' ? KIND_ZOMBIE_BIT : 0);
    view.setUint8(off + 10, stateByte);
    view.setUint8(off + 11, quantStamina(e.stamina));
    off += ENTITY_BYTES;
  }

  // 4) Removed ids (delta only).
  if (delta) {
    for (const id of removed) {
      view.setUint16(off, id, true);
      off += 2;
    }
  }

  // 5) Events.
  for (const ev of events) {
    const hasPos = ev.x !== undefined || ev.y !== undefined || ev.z !== undefined;
    let presence = 0;
    if (ev.actorId !== undefined) presence |= EV_HAS_ACTOR;
    if (ev.targetId !== undefined) presence |= EV_HAS_TARGET;
    if (hasPos) presence |= EV_HAS_POS;

    view.setUint8(off, EVENT_TO_CODE[ev.kind] ?? 0);
    view.setUint8(off + 1, presence);
    off += 2;
    if (ev.actorId !== undefined) {
      view.setUint16(off, ev.actorId, true);
      off += 2;
    }
    if (ev.targetId !== undefined) {
      view.setUint16(off, ev.targetId, true);
      off += 2;
    }
    if (hasPos) {
      view.setFloat32(off, ev.x ?? 0, true);
      view.setFloat32(off + 4, ev.y ?? 0, true);
      view.setFloat32(off + 8, ev.z ?? 0, true);
      off += 12;
    }
  }

  return buffer;
}

/* -------------------------------------------------------------------------- */
/* Decode                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Decode a binary snapshot produced by {@link encodeSnapshotBinary} back into a
 * {@link DecodedSnapshot}. Positions/yaw/stamina come back dequantized (within
 * one quantization step of the originals); `state`/`kind`/event kinds map back
 * through the same stable tables. Throws on an unknown wire version.
 */
export function decodeSnapshotBinary(buf: ArrayBuffer): DecodedSnapshot {
  const view = new DataView(buf);
  let off = 0;

  const flags = view.getUint8(off);
  off += 1;
  const version = flags >> 4;
  if (version !== WIRE_VERSION) {
    throw new Error(`snapshot wire version ${version} != expected ${WIRE_VERSION}`);
  }
  const isDelta = (flags & FLAG_DELTA) !== 0;

  const tick = view.getUint32(off, true);
  off += 4;
  const ack = view.getUint32(off, true);
  off += 4;

  let baselineTick = -1;
  if (isDelta) {
    baselineTick = view.getUint32(off, true);
    off += 4;
  }

  const entityCount = view.getUint16(off, true);
  off += 2;
  let removedCount = 0;
  if (isDelta) {
    removedCount = view.getUint16(off, true);
    off += 2;
  }
  const eventCount = view.getUint16(off, true);
  off += 2;

  // Entities.
  const entities: EntitySnapshot[] = [];
  for (let i = 0; i < entityCount; i++) {
    const id = view.getUint16(off, true);
    const x = dequantXZ(view.getUint16(off + 2, true));
    const y = dequantY(view.getUint16(off + 4, true));
    const z = dequantXZ(view.getUint16(off + 6, true));
    const yaw = dequantYaw(view.getUint16(off + 8, true));
    const stateByte = view.getUint8(off + 10);
    const stamina = dequantStamina(view.getUint8(off + 11));
    off += ENTITY_BYTES;

    const kind: EntityKind = (stateByte & KIND_ZOMBIE_BIT) !== 0 ? 'zombie' : 'human';
    const state: EntityState = STATE_CODES[stateByte & ~KIND_ZOMBIE_BIT] ?? 'idle';
    entities.push({ id, kind, x, y, z, yaw, state, stamina });
  }

  // Removed ids (delta only).
  const removed: number[] = [];
  for (let i = 0; i < removedCount; i++) {
    removed.push(view.getUint16(off, true));
    off += 2;
  }

  // Events.
  const events: GameEvent[] = [];
  for (let i = 0; i < eventCount; i++) {
    const kind: EventKind = EVENT_CODES[view.getUint8(off)] ?? 'attack';
    const presence = view.getUint8(off + 1);
    off += 2;
    const ev: GameEvent = { kind };
    if ((presence & EV_HAS_ACTOR) !== 0) {
      ev.actorId = view.getUint16(off, true);
      off += 2;
    }
    if ((presence & EV_HAS_TARGET) !== 0) {
      ev.targetId = view.getUint16(off, true);
      off += 2;
    }
    if ((presence & EV_HAS_POS) !== 0) {
      ev.x = view.getFloat32(off, true);
      ev.y = view.getFloat32(off + 4, true);
      ev.z = view.getFloat32(off + 8, true);
      off += 12;
    }
    events.push(ev);
  }

  return { isDelta, tick, ack, baselineTick, entities, removed, events };
}
