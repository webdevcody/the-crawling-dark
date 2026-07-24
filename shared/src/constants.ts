/**
 * Shared, authoritative tunables for The Crawling Dark.
 *
 * These values are imported by BOTH the client and the server so the two
 * sides never drift. Changing a number here changes it everywhere — never
 * duplicate these constants in package-local code.
 *
 * Values are aligned with the "locked" numbers in docs/DESIGN.md. World units
 * are meters and speeds are meters per second unless noted otherwise.
 */

/* -------------------------------------------------------------------------- */
/* Simulation & networking rates                                              */
/* -------------------------------------------------------------------------- */

/** Server simulation ticks per second (fixed timestep). */
export const TICK_RATE = 30;

/** Milliseconds per simulation tick (derived from {@link TICK_RATE}). */
export const TICK_MS = 1000 / TICK_RATE;

/** Snapshots broadcast to clients per second. */
export const SNAPSHOT_RATE = 15;

/** Milliseconds between broadcast snapshots (derived from {@link SNAPSHOT_RATE}). */
export const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;

/** Number of simulation ticks between snapshots (derived; ~every 2nd tick). */
export const SNAPSHOT_TICK_INTERVAL = TICK_RATE / SNAPSHOT_RATE;

/** Target client render frame rate. */
export const CLIENT_FPS = 60;

/**
 * Interpolation buffer for remote entities, in milliseconds. Remote entities
 * are rendered this far "in the past" so snapshot jitter can be smoothed.
 */
export const INTERP_BUFFER_MS = 100;

/* -------------------------------------------------------------------------- */
/* Movement                                                                   */
/* -------------------------------------------------------------------------- */

/** Horizontal movement speed while crawling, world units (meters) per second. */
export const MOVE_SPEED_CRAWL = 1.5;

/** Horizontal movement speed while walking, world units (meters) per second. */
export const MOVE_SPEED_WALK = 3.5;

/** Horizontal movement speed while running, world units (meters) per second. */
export const MOVE_SPEED_RUN = 6.5;

/**
 * Upward velocity applied on jump, world units per second. With
 * {@link GRAVITY} this yields a peak jump height of ~1.2 m.
 */
export const JUMP_VELOCITY = 6.6;

/** Downward acceleration, world units per second squared. */
export const GRAVITY = 18.0;

/** Cylinder radius used for XZ (circle-vs-AABB) player collision, in meters. */
export const PLAYER_RADIUS = 0.4;

/** Standing capsule height in meters (used for camera/collision). */
export const PLAYER_HEIGHT = 1.8;

/** Crawling capsule height in meters (smaller profile, harder to spot). */
export const CRAWL_HEIGHT = 0.9;

/* -------------------------------------------------------------------------- */
/* Combat & infection                                                         */
/* -------------------------------------------------------------------------- */

/** Cooldown between bat swings, in milliseconds. */
export const ATTACK_COOLDOWN_MS = 800;

/** Reach of a bat swing from the attacker's center, in meters. */
export const BAT_RANGE = 2.0;

/** Full angular width of the bat swing cone, in degrees (~120° arc). */
export const BAT_ARC_DEG = 120;

/** How long a bat hit stuns a zombie, in milliseconds (~1.5 s). */
export const STUN_DURATION_MS = 1500;

/** Knockback impulse applied to a zombie on a bat hit, world units per second. */
export const BAT_KNOCKBACK = 8.0;

/**
 * Contact radius (meters) within which a zombie's attack window infects a
 * human — capsule-overlap threshold on the XZ plane.
 */
export const INFECTION_CONTACT_RADIUS = 1.0;

/** Delay before a downed human respawns as a zombie, in milliseconds. */
export const RESPAWN_DELAY_MS = 3000;

/* -------------------------------------------------------------------------- */
/* Round lifecycle                                                            */
/* -------------------------------------------------------------------------- */

/** Minimum ready players required to start a round. */
export const MIN_PLAYERS_TO_START = 2;

/** Maximum players in a single game room; spillover spectates. */
export const MAX_PLAYERS = 12;

/** Countdown length before an active round begins, in seconds. */
export const COUNTDOWN_SEC = 10;

/** Countdown length in milliseconds (derived from {@link COUNTDOWN_SEC}). */
export const COUNTDOWN_MS = COUNTDOWN_SEC * 1000;

/** Round length in seconds. Survive the full round (5:00) as a human to win. */
export const ROUND_LENGTH_SEC = 300;

/** Round length in milliseconds (derived from {@link ROUND_LENGTH_SEC}). */
export const ROUND_LENGTH_MS = ROUND_LENGTH_SEC * 1000;

/** Post-round results/scoreboard length before returning to lobby, in seconds. */
export const ROUND_END_SEC = 10;

/** Post-round length in milliseconds (derived from {@link ROUND_END_SEC}). */
export const ROUND_END_MS = ROUND_END_SEC * 1000;

/* -------------------------------------------------------------------------- */
/* World & server                                                             */
/* -------------------------------------------------------------------------- */

/** Length of the (square) town in world units. The map spans [-MAP_SIZE/2, MAP_SIZE/2] on X and Z. */
export const MAP_SIZE = 128;

/** Default port the authoritative WebSocket server listens on. */
export const DEFAULT_SERVER_PORT = 8080;
