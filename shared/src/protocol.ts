/**
 * The Crawling Dark wire protocol — the single source of truth for every
 * message that crosses the socket. Both the client and the authoritative
 * server import from here so the two sides can never drift (M1 · t1a).
 *
 * Transport is JSON to start (readable, fast to build); every message is a
 * flat object tagged with a `t` discriminant: `{ t: <MessageType>, ...payload }`.
 * The optimization path to binary/delta encoding (M7) can replace
 * {@link encode}/{@link decode} without touching these interfaces.
 */

/* -------------------------------------------------------------------------- */
/* Message types                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every message's `t` discriminant. Kept as a const object (not a TS `enum`)
 * so the values survive `isolatedModules`/`verbatimModuleSyntax` and read as
 * plain strings on the wire.
 */
export const MessageType = {
  // ── Client → Server ──
  /** First message after connect: claim a display name. */
  Join: 'JOIN',
  /** Held-key sample sent every client frame. */
  Input: 'INPUT',
  /** Bat swing request. */
  Attack: 'ATTACK',
  /** Lobby ready/unready toggle. */
  Ready: 'READY',
  /** Latency probe; the server echoes it back as {@link MessageType.Pong}. */
  Ping: 'PING',

  // ── Server → Client ──
  /** Sent once on join: your player id and room parameters. */
  Welcome: 'WELCOME',
  /** Periodic authoritative world state. */
  Snapshot: 'SNAPSHOT',
  /** One-off gameplay event (attack/infect/stun/…). */
  Event: 'EVENT',
  /** Round phase + clock + score. */
  Round: 'ROUND',
  /** Reply to a {@link MessageType.Ping}. */
  Pong: 'PONG',
} as const;

/** Union of every message-type string. */
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/* -------------------------------------------------------------------------- */
/* Input key bitmask                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Held-key bitmask carried by {@link InputMessage}. Packing the movement keys
 * into a single integer keeps INPUT frames tiny (they are sent every frame).
 */
export const InputKey = {
  Forward: 1 << 0,
  Back: 1 << 1,
  Left: 1 << 2,
  Right: 1 << 3,
  Run: 1 << 4,
  Crawl: 1 << 5,
  Jump: 1 << 6,
} as const;

/** Union of the individual input-key bit values. */
export type InputKey = (typeof InputKey)[keyof typeof InputKey];

/** True when `bit` is set in the `keys` bitmask. */
export function hasKey(keys: number, bit: InputKey): boolean {
  return (keys & bit) !== 0;
}

/* -------------------------------------------------------------------------- */
/* Entity & round enums                                                       */
/* -------------------------------------------------------------------------- */

/** Which side / archetype a snapshot entity is. */
export type EntityKind = 'human' | 'zombie';

/**
 * Coarse movement/animation state of an entity, used to drive client visuals.
 * Extended as later milestones add combat and infection states.
 */
export type EntityState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'crawl'
  | 'jump'
  | 'attack'
  | 'stun'
  | 'down';

/** Round-lifecycle phases (see DESIGN §1, round lifecycle). */
export type RoundPhase = 'lobby' | 'countdown' | 'active' | 'ended';

/** Discriminant for one-off {@link EventMessage}s. */
export type EventKind =
  | 'attack'
  | 'infect'
  | 'stun'
  | 'jump'
  | 'roundStart'
  | 'roundEnd';

/* -------------------------------------------------------------------------- */
/* Snapshot entity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One entity as it appears in a {@link SnapshotMessage}. Position is world-space
 * meters; `yaw` is the facing angle in radians. Intentionally flat and numeric
 * so it maps cleanly onto a future binary/quantized encoding (M7).
 */
export interface EntitySnapshot {
  /** Stable entity id (equals the owning player id for player entities). */
  id: number;
  kind: EntityKind;
  x: number;
  y: number;
  z: number;
  /** Facing angle around the Y axis, in radians. */
  yaw: number;
  state: EntityState;
  /**
   * Sprint stamina as a fraction in `[0, 1]` (1 = full, 0 = spent), fully
   * server-authoritative. It drains while this entity actually sprints and
   * regenerates otherwise (see {@link STAMINA_MAX} and its siblings), and it
   * gates sprint on the server — the client only mirrors it in the HUD bar.
   * NPCs never sprint, so they always report {@link STAMINA_MAX}.
   */
  stamina: number;
}

/* -------------------------------------------------------------------------- */
/* Client → Server messages                                                   */
/* -------------------------------------------------------------------------- */

/** Claim a display name; server replies with {@link WelcomeMessage}. */
export interface JoinMessage {
  t: typeof MessageType.Join;
  name: string;
  /**
   * Optional reconnect token from a prior {@link WelcomeMessage} (M7 · t7d).
   * Present only on a *re*connect: the client echoes the token it was issued so
   * the server can reclaim its original identity (id/team/position/combat) when
   * the matching session is still inside its {@link RECONNECT_GRACE_MS} grace
   * window. Absent on a first connect — the server then mints a fresh identity.
   * Additive: a server that predates t7d simply ignores the extra field.
   */
  token?: string;
}

/**
 * A single sampled input frame. `seq` monotonically increases per client and
 * is echoed back in {@link SnapshotMessage.ack} so prediction can reconcile
 * (reconciliation itself lands in M6).
 */
export interface InputMessage {
  t: typeof MessageType.Input;
  seq: number;
  /** Held-key bitmask; test bits with {@link InputKey} / {@link hasKey}. */
  keys: number;
  /** Aim/look yaw in radians. */
  yaw: number;
  /** Client frame delta in seconds (advisory; the server is authoritative). */
  dt: number;
}

/** Request a bat swing. */
export interface AttackMessage {
  t: typeof MessageType.Attack;
  seq: number;
}

/** Toggle lobby ready state. */
export interface ReadyMessage {
  t: typeof MessageType.Ready;
  ready: boolean;
}

/** Latency probe; `id` is echoed back verbatim in {@link PongMessage}. */
export interface PingMessage {
  t: typeof MessageType.Ping;
  id: number;
}

/** Any message the client may send to the server. */
export type ClientMessage =
  | JoinMessage
  | InputMessage
  | AttackMessage
  | ReadyMessage
  | PingMessage;

/* -------------------------------------------------------------------------- */
/* Server → Client messages                                                   */
/* -------------------------------------------------------------------------- */

/** Sent once, right after the socket joins the room. */
export interface WelcomeMessage {
  t: typeof MessageType.Welcome;
  /** The id of the entity this client controls. */
  playerId: number;
  /** Authoritative simulation rate (Hz) so the client can size its buffers. */
  tickRate: number;
  /** Seed the deterministic town geometry is built from (M2). */
  mapSeed: number;
  /**
   * Opaque session token for reconnect (M7 · t7d). The client persists this and
   * echoes it back in a later {@link JoinMessage.token} to reclaim this exact
   * identity after a drop, provided the reconnect lands inside the server's
   * {@link RECONNECT_GRACE_MS} grace window. A reconnect re-issues the SAME
   * token alongside the SAME {@link playerId}. Additive: pre-t7d clients that
   * never read it are unaffected.
   */
  token: string;
}

/**
 * Authoritative world state, broadcast at {@link SNAPSHOT_RATE}. `ack` is
 * personalized per recipient: it is that client's most recently processed
 * input `seq`.
 */
export interface SnapshotMessage {
  t: typeof MessageType.Snapshot;
  /** Server simulation tick this snapshot was taken on. */
  tick: number;
  /** The recipient's last input `seq` the server has applied. */
  ack: number;
  entities: EntitySnapshot[];
  /** Events that occurred since the previous snapshot, if any. */
  events?: GameEvent[];
}

/** A one-off gameplay event (also surfaced inline in snapshots). */
export interface GameEvent {
  kind: EventKind;
  /** Entity that caused the event, when applicable. */
  actorId?: number;
  /** Entity affected by the event, when applicable. */
  targetId?: number;
  /** World-space location of the event, when applicable. */
  x?: number;
  y?: number;
  z?: number;
}

/** Standalone event message (for events not tied to a snapshot). */
export interface EventMessage extends GameEvent {
  t: typeof MessageType.Event;
}

/** Round phase, clock, and live score. */
export interface RoundMessage {
  t: typeof MessageType.Round;
  phase: RoundPhase;
  /** Milliseconds remaining in the current phase. */
  timeLeftMs: number;
  humansAlive: number;
  zombieCount: number;
  /** Set only when `phase === 'ended'`. */
  winner?: EntityKind;
  /**
   * Lobby only: how many connected (non-spectator) players have readied up.
   * Lets the HUD show a "READY n/total" gate. Omitted outside the lobby phase.
   */
  readyCount?: number;
  /**
   * Lobby only: total connected, non-spectator players (the denominator for
   * {@link readyCount}). Omitted outside the lobby phase.
   */
  playerCount?: number;
}

/** Reply to a {@link PingMessage}; `id` matches the probe. */
export interface PongMessage {
  t: typeof MessageType.Pong;
  id: number;
}

/** Any message the server may send to a client. */
export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | EventMessage
  | RoundMessage
  | PongMessage;

/** Every message on the wire, in either direction. */
export type NetMessage = ClientMessage | ServerMessage;

/**
 * A received wire payload. In the browser a text frame arrives as a `string`;
 * on the server the `ws` library delivers a Node `Buffer`, whose `toString()`
 * decodes UTF-8. Typing it structurally keeps this package free of any
 * DOM/Node lib dependency.
 */
export type WireData = string | { toString(): string };

/* -------------------------------------------------------------------------- */
/* Encode / decode                                                            */
/* -------------------------------------------------------------------------- */

/** Serialize any protocol message to a wire string. */
export function encode(msg: NetMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse a wire payload into a message object, or `null` if it is not valid
 * JSON with a string `t` tag. Callers narrow on `.t` (a {@link MessageType})
 * to reach a concrete payload type.
 *
 * Accepts either a `string` (browser text frame) or anything with a UTF-8
 * `toString()` such as a Node `Buffer` (a `ws` message payload), so it can be
 * fed a socket message directly.
 */
export function decode(data: WireData): NetMessage | null {
  const text = typeof data === 'string' ? data : data.toString();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as { t?: unknown }).t === 'string'
  ) {
    return parsed as NetMessage;
  }
  return null;
}

/** Decode and narrow to a {@link ClientMessage} (server-side ingress). */
export function decodeClientMessage(data: WireData): ClientMessage | null {
  return decode(data) as ClientMessage | null;
}

/** Decode and narrow to a {@link ServerMessage} (client-side ingress). */
export function decodeServerMessage(data: WireData): ServerMessage | null {
  return decode(data) as ServerMessage | null;
}
