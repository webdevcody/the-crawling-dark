/**
 * Shared, authoritative tunables for The Crawling Dark.
 *
 * These values are imported by BOTH the client and the server so the two
 * sides never drift. Changing a number here changes it everywhere — never
 * duplicate these constants in package-local code.
 */

/** Server simulation ticks per second. */
export const TICK_RATE = 20;

/** Milliseconds per simulation tick (derived from {@link TICK_RATE}). */
export const TICK_MS = 1000 / TICK_RATE;

/** Snapshots broadcast to clients per second. */
export const SNAPSHOT_RATE = 10;

/** Milliseconds between broadcast snapshots (derived from {@link SNAPSHOT_RATE}). */
export const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;

/** Horizontal movement speeds in world units per second. */
export const MOVE_SPEED_CRAWL = 1.5;
export const MOVE_SPEED_WALK = 4.0;
export const MOVE_SPEED_RUN = 7.0;

/** Upward velocity applied on jump, world units per second. */
export const JUMP_VELOCITY = 6.0;

/** Downward acceleration, world units per second squared. */
export const GRAVITY = 18.0;

/** Length of the (square) town in world units. The map spans [-MAP_SIZE/2, MAP_SIZE/2] on X and Z. */
export const MAP_SIZE = 128;

/** Round length in seconds. Survive the full round (5:00) as a human to win. */
export const ROUND_LENGTH_SEC = 300;

/** Default port the authoritative WebSocket server listens on. */
export const DEFAULT_SERVER_PORT = 8080;
