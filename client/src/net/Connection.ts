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
 * All wire shapes come from `@crawling-dark/shared` — the frozen single source
 * of truth. This module never invents its own message formats.
 */

import {
  MessageType,
  DEFAULT_SERVER_PORT,
  encode,
  decodeServerMessage,
  type EntitySnapshot,
} from '@crawling-dark/shared';

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

  private readonly url: string;
  private readonly name: string;

  private socket: WebSocket | null = null;
  private statusValue: ConnectionStatus = 'closed';

  /** Our controlled entity id, from WELCOME. `null` until the first WELCOME. */
  private ownId: number | null = null;

  /** Latest server tick seen in a SNAPSHOT. */
  private serverTick = 0;

  /** Most recent input `seq` the server has acknowledged (SNAPSHOT.ack). */
  private ackSeq = 0;

  /** Smoothed round-trip time in milliseconds (0 until the first PONG). */
  private smoothedRtt = 0;

  private inputSeq = 0;
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

  /** Read-only view of the current entity store. */
  get entities(): ReadonlyMap<number, EntitySnapshot> {
    return this.store;
  }

  /** Number of entities currently known. */
  get entityCount(): number {
    return this.store.size;
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
    this.send({ t: MessageType.Join, name: this.name });
    this.startPingLoop();
  }

  private handleClose(): void {
    this.stopPingLoop();
    this.pendingPings.clear();
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
    const msg = decodeServerMessage(data as string);
    if (!msg) return;

    switch (msg.t) {
      case MessageType.Welcome:
        this.ownId = msg.playerId;
        break;

      case MessageType.Snapshot: {
        this.serverTick = msg.tick;
        this.ackSeq = msg.ack;
        this.store.clear();
        for (const entity of msg.entities) {
          this.store.set(entity.id, entity);
        }
        break;
      }

      case MessageType.Pong: {
        const sentAt = this.pendingPings.get(msg.id);
        if (sentAt !== undefined) {
          this.pendingPings.delete(msg.id);
          this.recordRtt(performance.now() - sentAt);
        }
        break;
      }

      // ROUND / EVENT are not consumed in M1; ignore them for now.
      default:
        break;
    }
  }

  private recordRtt(sample: number): void {
    this.smoothedRtt =
      this.smoothedRtt === 0
        ? sample
        : this.smoothedRtt * (1 - RTT_SMOOTHING) + sample * RTT_SMOOTHING;
  }

  /* ---- Outbound frames -------------------------------------------------- */

  /**
   * Send one sampled input frame. Called once per render frame with the live
   * held-key bitmask; `seq` auto-increments so the server can ack it. `yaw` is
   * fixed to 0 in M1 (no look controls yet). No-op while the socket is down.
   *
   * @param keys Held-key bitmask (see `InputKey` in the shared protocol).
   * @param dt   Frame delta in seconds (advisory; the server is authoritative).
   * @param yaw  Aim yaw in radians (0 in M1).
   */
  sendInput(keys: number, dt: number, yaw = 0): void {
    this.send({
      t: MessageType.Input,
      seq: ++this.inputSeq,
      keys,
      yaw,
      dt,
    });
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
