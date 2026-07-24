/**
 * Client networking spine for The Crawling Dark (M1 · t1d).
 *
 * `Connection` owns the browser WebSocket to the authoritative server and is
 * deliberately free of any Three.js / rendering dependency so it can be reused
 * by tools, tests, or a future headless client. Its responsibilities:
 *
 *   - open the socket and (re)connect with capped exponential backoff;
 *   - announce the player with a {@link MessageType.Join} on every open;
 *   - stream {@link MessageType.Input} frames the render loop pushes each frame;
 *   - probe latency with periodic {@link MessageType.Ping}s and smooth the RTT;
 *   - decode inbound frames via {@link decodeServerMessage} and fold them into a
 *     small observable state surface (entity store, playerId, tick, status).
 *
 * As of M2 (t2f) it also feeds each snapshot into a {@link SnapshotInterpolator}
 * so remote entities can be rendered ~{@link INTERP_BUFFER_MS} in the past and
 * move smoothly between the coarse authoritative updates.
 *
 * All wire shapes come from `@crawling-dark/shared` — the frozen single source
 * of truth. This module never invents its own message formats.
 */

import {
  MessageType,
  DEFAULT_SERVER_PORT,
  SNAPSHOT_BASELINE_RING,
  encode,
  decodeServerMessage,
  decodeSnapshotBinary,
  type EntitySnapshot,
  type GameEvent,
  type InputMessage,
  type JoinMessage,
  type RoundMessage,
} from '@crawling-dark/shared';

import { SnapshotInterpolator, type InterpolatedEntity } from './Interpolation';

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/** Coarse lifecycle of the underlying socket, surfaced for the HUD. */
export type ConnectionStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed';

/* -------------------------------------------------------------------------- */
/* Tunables (client-local; not part of the shared wire contract)              */
/* -------------------------------------------------------------------------- */

/** How often to send a latency probe, in milliseconds. */
const PING_INTERVAL_MS = 1000;

/** First reconnect delay; doubles each failed attempt up to {@link BACKOFF_CAP_MS}. */
const BACKOFF_BASE_MS = 250;

/** Ceiling for the exponential reconnect backoff, in milliseconds. */
const BACKOFF_CAP_MS = 5000;

/** EMA weight for the newest RTT sample (0..1). Higher = more responsive. */
const RTT_SMOOTHING = 0.2;

/** Cap on outstanding (unanswered) ping timestamps we retain. */
const MAX_PENDING_PINGS = 32;

/**
 * Cap on gameplay events buffered for the render loop. Bounds memory if the
 * loop stalls (e.g. a backgrounded tab stops draining); the newest events win.
 */
const MAX_PENDING_EVENTS = 128;

/**
 * How many recently applied full snapshot states to retain, keyed by tick, for
 * applying binary deltas (M7 · t7b). A delta names the ACKed `baselineTick` it
 * was diffed against; we rebuild the world by applying it onto the stored state
 * for that tick. Kept a little deeper than the server's {@link SNAPSHOT_BASELINE_RING}
 * so the baseline the server chose is always still present locally even while
 * an ack is in flight. Unused while the wire is JSON.
 */
const SNAPSHOT_HISTORY = SNAPSHOT_BASELINE_RING + 8;

/* -------------------------------------------------------------------------- */
/* URL resolution                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the server WebSocket URL. Honors `VITE_SERVER_URL` when provided
 * (e.g. a tunneled deploy), otherwise derives `ws://<host>:8080` from the page
 * origin so a plain `pnpm dev` "just works" against a local server.
 */
function resolveServerUrl(): string {
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv;
  }
  const host = location.hostname || 'localhost';
  return `ws://${host}:${DEFAULT_SERVER_PORT}`;
}

/** Generate a throwaway display name for M1 (real names arrive with the lobby). */
function randomName(): string {
  return `player-${Math.random().toString(36).slice(2, 7)}`;
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A resilient, self-reconnecting client connection plus the derived world
 * state the renderer reads each frame. Construct it, call {@link connect}, then
 * pump {@link sendInput} from the render loop and read {@link entities},
 * {@link playerId}, {@link tick}, {@link rttMs}, and {@link status}.
 */
export class Connection {
  /** Latest authoritative entities, keyed by id (replaced each snapshot). */
  private readonly store = new Map<number, EntitySnapshot>();

  /** performance.now() timestamps of pings still awaiting a PONG, by id. */
  private readonly pendingPings = new Map<number, number>();

  /**
   * Gameplay events (attack/stun/infect/…) received since the render loop last
   * drained them, in arrival order. The renderer pulls these each frame via
   * {@link drainEvents} to spawn combat VFX and push turn-feed lines; keeping
   * them in a plain queue (rather than firing a callback) preserves this
   * module's freedom from any Three.js / rendering dependency.
   */
  private readonly pendingEvents: GameEvent[] = [];

  /**
   * Buffers received snapshots and samples them ~{@link INTERP_BUFFER_MS} in the
   * past, so remote entities render smoothly between authoritative updates.
   */
  private readonly interp = new SnapshotInterpolator();

  private readonly url: string;
  private readonly name: string;

  private socket: WebSocket | null = null;
  private statusValue: ConnectionStatus = 'closed';

  /** Our controlled entity id, from WELCOME. `null` until the first WELCOME. */
  private ownId: number | null = null;

  /** Deterministic town seed from WELCOME. `null` until the first WELCOME. */
  private mapSeedValue: number | null = null;

  /**
   * Reconnect session token from the most recent WELCOME (M7 · t7d), or `null`
   * before the first one. It is echoed back in the JOIN on EVERY (re)open so a
   * reconnect presents it and the server can restore our original id/team; a
   * first connect sends no token. Deliberately NOT cleared on socket close — it
   * must survive the drop so the auto-reconnect can hand it back — so it
   * persists across the whole session and only ever advances to a newer token.
   */
  private sessionToken: string | null = null;

  /** Latest server tick seen in a SNAPSHOT. */
  private serverTick = 0;

  /** Most recent input `seq` the server has acknowledged (SNAPSHOT.ack). */
  private ackSeq = 0;

  /**
   * Tick of the most recent snapshot we have fully applied, sent back to the
   * server as {@link InputMessage.snapAck} so it can delta-compress against a
   * baseline we are confirmed to hold (M7 · t7b). `null` until the first
   * snapshot lands (so the server's first frame to us is always a FULL one).
   */
  private snapAckTick: number | null = null;

  /**
   * Recently applied FULL entity states keyed by their snapshot tick — the
   * baselines binary deltas are applied onto (M7 · t7b). Each entry is the
   * complete reconstructed entity list for that tick; capped at
   * {@link SNAPSHOT_HISTORY} (oldest evicted). Cleared on disconnect so a
   * reconnect starts clean from the server's next full frame.
   */
  private readonly snapshotHistory = new Map<number, EntitySnapshot[]>();

  /** Smoothed round-trip time in milliseconds (0 until the first PONG). */
  private smoothedRtt = 0;

  /**
   * Latest ROUND frame (phase + clock + score), or `null` before the first one
   * arrives. Cleared to `null` on disconnect so a stale win/lose banner can't
   * linger over a reconnect gap — the HUD falls back to its pre-ROUND look until
   * the server's next ROUND repaints it.
   */
  private roundValue: RoundMessage | null = null;

  private inputSeq = 0;
  private attackSeq = 0;
  private pingSeq = 0;

  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;

  /** Set by {@link close} so a deliberate teardown does not auto-reconnect. */
  private disposed = false;

  constructor(url: string = resolveServerUrl(), name: string = randomName()) {
    this.url = url;
    this.name = name;
  }

  /* ---- Observable state (read by the renderer / HUD) -------------------- */

  /** Current socket lifecycle status. */
  get status(): ConnectionStatus {
    return this.statusValue;
  }

  /** Our controlled entity id, or `null` before WELCOME arrives. */
  get playerId(): number | null {
    return this.ownId;
  }

  /** Deterministic map seed from WELCOME, or `null` before it arrives. */
  get mapSeed(): number | null {
    return this.mapSeedValue;
  }

  /** Latest server simulation tick from the most recent snapshot. */
  get tick(): number {
    return this.serverTick;
  }

  /** Server's last acknowledged input `seq` (for future reconciliation, M6). */
  get ack(): number {
    return this.ackSeq;
  }

  /** Smoothed round-trip time in milliseconds. */
  get rttMs(): number {
    return this.smoothedRtt;
  }

  /**
   * Latest ROUND frame (phase, clock, score, lobby ready-gate), or `null`
   * before the first one arrives or after a disconnect. The HUD reads this each
   * frame to drive its banner + counts; a `null` return means "no round state
   * yet", for which the HUD shows a graceful placeholder.
   */
  get round(): RoundMessage | null {
    return this.roundValue;
  }

  /** Read-only view of the current entity store. */
  get entities(): ReadonlyMap<number, EntitySnapshot> {
    return this.store;
  }

  /** Number of entities currently known. */
  get entityCount(): number {
    return this.store.size;
  }

  /**
   * Interpolated entities for rendering, sampled ~INTERP_BUFFER_MS in the past
   * to smooth snapshot jitter (see {@link SnapshotInterpolator}). Returns a
   * fresh map keyed by entity id; `nowMs` defaults to `performance.now()`.
   */
  sampleEntities(nowMs?: number): Map<number, InterpolatedEntity> {
    return this.interp.sample(nowMs ?? performance.now());
  }

  /**
   * Return every gameplay event received since the last call and clear the
   * queue (an empty array when nothing is pending). Called once per render
   * frame; the renderer turns these into combat VFX and turn-feed lines.
   */
  drainEvents(): GameEvent[] {
    if (this.pendingEvents.length === 0) return [];
    return this.pendingEvents.splice(0, this.pendingEvents.length);
  }

  /* ---- Connection lifecycle -------------------------------------------- */

  /** Open the socket (idempotent while an open/connecting socket exists). */
  connect(): void {
    this.disposed = false;
    if (this.socket) return;
    this.open();
  }

  /**
   * Tear the connection down for good: stops timers, prevents reconnects, and
   * closes any live socket. Call on page unload / component teardown.
   */
  close(): void {
    this.disposed = true;
    this.clearReconnect();
    this.stopPingLoop();
    this.interp.clear();
    this.snapshotHistory.clear();
    this.snapAckTick = null;
    this.pendingEvents.length = 0;
    this.roundValue = null;
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      try {
        this.socket.close();
      } catch {
        /* already closing; ignore */
      }
      this.socket = null;
    }
    this.statusValue = 'closed';
  }

  private open(): void {
    this.statusValue = this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      // Construction can throw on a malformed URL; treat as a failed attempt.
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    // Snapshots arrive as binary frames (M7 · t7a); ask for ArrayBuffers so
    // handleMessage can tell a snapshot (ArrayBuffer) from the JSON control
    // messages (string) purely by payload type.
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => this.handleOpen();
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => this.handleClose();
    ws.onerror = () => {
      // `error` is always followed by `close`; let handleClose drive reconnect.
    };
  }

  private handleOpen(): void {
    this.statusValue = 'open';
    this.reconnectAttempts = 0;
    // Announce ourselves. On a reconnect we carry the token from our last
    // WELCOME so the server can reclaim our original identity/team within its
    // grace window (M7 · t7d); a first connect has no token and gets a fresh id.
    const join: JoinMessage = { t: MessageType.Join, name: this.name };
    if (this.sessionToken !== null) join.token = this.sessionToken;
    this.send(join);
    this.startPingLoop();
  }

  private handleClose(): void {
    this.stopPingLoop();
    this.pendingPings.clear();
    // Drop buffered snapshots so stale remote positions don't linger across the
    // gap; the interpolator refills from fresh snapshots after we reconnect.
    this.interp.clear();
    // Reset the delta baselines: the reconnected socket is a fresh server-side
    // Player, so its first frame to us will be a full snapshot again (M7 · t7b).
    this.snapshotHistory.clear();
    this.snapAckTick = null;
    this.pendingEvents.length = 0;
    // Clear the round so a stale win/lose banner can't linger across the gap;
    // the server's next ROUND repaints it after we reconnect.
    this.roundValue = null;
    this.socket = null;
    if (this.disposed) {
      this.statusValue = 'closed';
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.min(
      BACKOFF_CAP_MS,
      BACKOFF_BASE_MS * 2 ** this.reconnectAttempts,
    ) * jitter;
    this.reconnectAttempts += 1;
    this.statusValue = 'reconnecting';
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /* ---- Inbound message handling ---------------------------------------- */

  private handleMessage(data: unknown): void {
    // Binary frames are quantized SNAPSHOTs (M7 · t7a/t7b); everything else is
    // JSON text. Branch on the payload type so the two never collide.
    if (data instanceof ArrayBuffer) {
      this.handleBinarySnapshot(data);
      return;
    }

    const msg = decodeServerMessage(data as string);
    if (!msg) return;

    switch (msg.t) {
      case MessageType.Welcome:
        this.ownId = msg.playerId;
        this.mapSeedValue = msg.mapSeed;
        // Persist the reconnect token so the next (re)open can present it and
        // reclaim this identity (t7d). On a reconnect the server re-issues the
        // SAME token here alongside the SAME playerId.
        this.sessionToken = msg.token;
        break;

      case MessageType.Snapshot:
        // JSON fallback path (SNAPSHOT_WIRE === 'json'): a full snapshot. The
        // binary path funnels through the same {@link ingestSnapshot} below.
        this.ingestSnapshot(msg.tick, msg.ack, msg.entities, msg.events);
        break;

      case MessageType.Pong: {
        const sentAt = this.pendingPings.get(msg.id);
        if (sentAt !== undefined) {
          this.pendingPings.delete(msg.id);
          this.recordRtt(performance.now() - sentAt);
        }
        break;
      }

      case MessageType.Event:
        // A standalone event (not folded into a snapshot). Its `t` tag rides
        // along harmlessly; downstream consumers read only the GameEvent fields.
        this.enqueueEvents([msg]);
        break;

      case MessageType.Round:
        // Latest round phase + clock + score. Stored whole (the `t` tag rides
        // along harmlessly) and surfaced via {@link round}; the HUD drives its
        // banner, lobby ready-gate, and live counts from this each frame.
        this.roundValue = msg;
        break;

      // Any unknown/future message type: ignore it rather than crash.
      default:
        break;
    }
  }

  /**
   * Decode and apply a binary SNAPSHOT frame (M7 · t7a/t7b).
   *
   *   - A FULL frame replaces our world outright.
   *   - A DELTA frame is applied onto the stored baseline for its
   *     `baselineTick` — an ACKed tick we are guaranteed to still hold: start
   *     from that full state, set the changed/added entities, drop the removed
   *     ids. That reconstructed full set then feeds the identical downstream as
   *     any snapshot. If the baseline is somehow missing (should not happen —
   *     the server only deltas against a frame we ACKed and our history is
   *     deeper than its ring) we skip the frame and keep our last good state;
   *     the next frame re-baselines once our ack catches up.
   */
  private handleBinarySnapshot(buf: ArrayBuffer): void {
    let decoded;
    try {
      decoded = decodeSnapshotBinary(buf);
    } catch {
      // A malformed/opaque frame (e.g. version skew): ignore rather than crash.
      return;
    }

    if (!decoded.isDelta) {
      this.ingestSnapshot(decoded.tick, decoded.ack, decoded.entities, decoded.events);
      return;
    }

    const baseline = this.snapshotHistory.get(decoded.baselineTick);
    if (baseline === undefined) return; // baseline aged out; wait for a full frame

    // Rebuild the full entity set: baseline, then apply the delta's changes.
    const byId = new Map<number, EntitySnapshot>();
    for (const e of baseline) byId.set(e.id, e);
    for (const e of decoded.entities) byId.set(e.id, e);
    for (const id of decoded.removed) byId.delete(id);

    this.ingestSnapshot(
      decoded.tick,
      decoded.ack,
      Array.from(byId.values()),
      decoded.events,
    );
  }

  /**
   * Fold a reconstructed full snapshot (from either wire path) into the
   * observable state: refresh the entity store, feed the interpolator, surface
   * events, and advance `tick`/`ack`. Then remember this full state as a delta
   * baseline and mark its tick to ACK on the next INPUT (M7 · t7b). The single
   * choke-point both the JSON and binary paths share, so nothing downstream can
   * tell which encoding delivered the frame.
   */
  private ingestSnapshot(
    tick: number,
    ack: number,
    entities: readonly EntitySnapshot[],
    events: readonly GameEvent[] | undefined,
  ): void {
    this.serverTick = tick;
    this.ackSeq = ack;

    this.store.clear();
    for (const entity of entities) this.store.set(entity.id, entity);

    // Feed the interpolation buffer, tagged with the local receive time.
    this.interp.push(entities, performance.now());

    // Surface any events the server buffered onto this snapshot so the render
    // loop can spawn combat VFX and update the turn feed. We stay render-
    // agnostic here: only the raw shared events are queued.
    if (events && events.length > 0) this.enqueueEvents(events);

    // t7b: retain this full state as a future delta baseline and ACK its tick.
    this.recordSnapshotState(tick, entities);
    this.snapAckTick = tick;
  }

  /**
   * Store the full entity list for `tick` as a delta baseline, evicting the
   * oldest once the history exceeds {@link SNAPSHOT_HISTORY}. The list is stored
   * by reference; entity objects are treated as immutable once ingested.
   */
  private recordSnapshotState(tick: number, entities: readonly EntitySnapshot[]): void {
    this.snapshotHistory.set(tick, entities.slice());
    while (this.snapshotHistory.size > SNAPSHOT_HISTORY) {
      const oldest = this.snapshotHistory.keys().next().value;
      if (oldest === undefined) break;
      this.snapshotHistory.delete(oldest);
    }
  }

  private recordRtt(sample: number): void {
    this.smoothedRtt =
      this.smoothedRtt === 0
        ? sample
        : this.smoothedRtt * (1 - RTT_SMOOTHING) + sample * RTT_SMOOTHING;
  }

  /**
   * Queue gameplay events for the render loop to {@link drainEvents}. If the
   * loop stalls (e.g. a backgrounded tab), bound memory by keeping only the
   * most recent {@link MAX_PENDING_EVENTS}.
   */
  private enqueueEvents(events: readonly GameEvent[]): void {
    for (const ev of events) this.pendingEvents.push(ev);
    const overflow = this.pendingEvents.length - MAX_PENDING_EVENTS;
    if (overflow > 0) this.pendingEvents.splice(0, overflow);
  }

  /* ---- Outbound frames -------------------------------------------------- */

  /**
   * Send one sampled input frame. As of M8 (t8a/t8c) the caller pumps this on a
   * FIXED timestep — once per simulation sub-step (~{@link TICK_RATE} Hz), NOT once
   * per render frame — so the INPUT rate is decoupled from the frame rate (a 144 Hz
   * client no longer floods and a 30 Hz client isn't starved) and `dt` is the fixed
   * tick delta rather than a variable render delta. This method's own behavior is
   * unchanged by that: `seq` auto-increments per call so the server can ack it, and
   * sending is a no-op while the socket is down, but the `seq` is still allocated
   * and returned so the caller's local prediction history stays continuous.
   *
   * Returns the `seq` assigned to this frame so the client-side predictor (M6) can
   * key its input history by it and reconcile against the server's `ack`. Existing
   * callers may ignore the return value — this is a backward-compatible change.
   *
   * @param keys Held-key bitmask (see `InputKey` in the shared protocol).
   * @param dt   Fixed sub-step delta in seconds (advisory; the server is authoritative).
   * @param yaw  Aim/look yaw in radians.
   * @returns The monotonic input `seq` sent for this frame.
   */
  sendInput(keys: number, dt: number, yaw = 0): number {
    const seq = ++this.inputSeq;
    const msg: InputMessage = { t: MessageType.Input, seq, keys, yaw, dt };
    // t7b: piggy-back the last snapshot tick we fully applied so the server can
    // delta-compress against a baseline we are confirmed to hold. Omitted until
    // the first snapshot arrives; ignored by the server while the wire is JSON.
    if (this.snapAckTick !== null) msg.snapAck = this.snapAckTick;
    this.send(msg);
    return seq;
  }

  /**
   * Request a bat swing. The server validates range/cooldown and, if the swing
   * lands, echoes `attack`/`stun`/`infect` events back on the next snapshot; we
   * only fire the intent here. `seq` rides its own monotonic counter (kept
   * separate from the INPUT `seq` so input acks stay clean) — the server just
   * needs it to increase. No-op while the socket is down.
   */
  sendAttack(): void {
    this.send({ t: MessageType.Attack, seq: ++this.attackSeq });
  }

  /**
   * Toggle our lobby ready state. The server tallies readied players and starts
   * the countdown once {@link MIN_PLAYERS_TO_START} are ready, echoing the count
   * back on each ROUND (`readyCount`/`playerCount`) during the lobby phase. We
   * only fire the intent here; like {@link sendAttack} it is a no-op while the
   * socket is down (the caller keeps the authoritative flag and the server
   * clears readiness on every reset, so a dropped toggle self-heals).
   */
  sendReady(ready: boolean): void {
    this.send({ t: MessageType.Ready, ready });
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.sendPing();
    this.pingTimer = window.setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private sendPing(): void {
    const id = ++this.pingSeq;
    this.pendingPings.set(id, performance.now());
    // Bound memory if replies are being dropped: drop the oldest pending probe.
    if (this.pendingPings.size > MAX_PENDING_PINGS) {
      const oldest = this.pendingPings.keys().next().value;
      if (oldest !== undefined) this.pendingPings.delete(oldest);
    }
    this.send({ t: MessageType.Ping, id });
  }

  /** Serialize and send a message when the socket is open; otherwise drop it. */
  private send(
    msg: Parameters<typeof encode>[0],
  ): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(encode(msg));
    } catch {
      /* transient send failure; the close handler will reconnect */
    }
  }
}
