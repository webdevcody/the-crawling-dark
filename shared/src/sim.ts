/**
 * Deterministic movement kinematics for The Crawling Dark (M2 · t2b).
 *
 * A single, PURE, framerate-independent movement step shared by BOTH sides of
 * the wire: the authoritative server steps every player through {@link step}
 * each fixed tick now, and the client reuses the exact same function for local
 * prediction/reconciliation in M6. Because both sides run identical math on
 * identical inputs, prediction stays in lockstep with the server.
 *
 * Scope is intentionally narrow — this module is *pure kinematics*: yaw-relative
 * horizontal motion, jump impulse, gravity, and a ground clamp at `y == 0`.
 * It deliberately does NOT know about the world: building/perimeter collision
 * lives in `world.ts` and is resolved by the caller AFTER `step` advances the
 * unobstructed position (see DESIGN §5, step 2).
 *
 * Determinism contract (the whole point of this file):
 *   - Fixed `dt` is passed in; the module never reads a clock.
 *   - No `Math.random` — nothing here is stochastic.
 *   - Inputs are never mutated; `step` returns a brand-new {@link MoveState}.
 * Given identical `(state, input, dt)` the output is bit-for-bit identical.
 *
 * World units are meters; angles are radians; velocities are meters/second.
 */

import { InputKey, hasKey } from './protocol';
import {
  MOVE_SPEED_WALK,
  MOVE_SPEED_RUN,
  MOVE_SPEED_CRAWL,
  JUMP_VELOCITY,
  GRAVITY,
} from './constants';

/* -------------------------------------------------------------------------- */
/* State & input types                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Full kinematic state of one movable entity (server-authoritative; reused by
 * client prediction in M6).
 *
 * Only the vertical axis carries velocity (`vy`): horizontal motion is derived
 * fresh from the held keys each step rather than integrated, so there is no
 * momentum to desync. `grounded` and `crawling` are latched booleans the sim
 * reads and rewrites according to the rules in {@link step}.
 */
export interface MoveState {
  /** World position on the X axis, meters. */
  x: number;
  /** World position on the Y (vertical) axis, meters; `0` is the ground plane. */
  y: number;
  /** World position on the Z axis, meters. */
  z: number;
  /** Facing angle in radians, measured around the +Y axis. */
  yaw: number;
  /** Vertical velocity, meters/second (positive is up). */
  vy: number;
  /** Whether the entity is resting on the ground plane (`y == 0`). */
  grounded: boolean;
  /** Latched low-profile (smaller-hitbox) crawl mode; only toggles while grounded. */
  crawling: boolean;
}

/**
 * The subset of an INPUT frame the sim consumes. This is a projection of the
 * networked {@link import('./protocol').InputMessage} — the sim needs only the
 * held keys and the desired facing, not the sequence number or advisory `dt`.
 */
export interface SimInput {
  /**
   * Held-key bitmask (test with {@link InputKey} / {@link hasKey}). The `Crawl`
   * bit is the client-latched crawl MODE (on/off), not a per-frame tap.
   */
  keys: number;
  /** Desired facing / look yaw in radians (mouse-driven on the client). */
  yaw: number;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Construct a {@link MoveState}, defaulting everything to a grounded, standing
 * entity at the world origin. Any subset of fields may be overridden via
 * `init`; omitted fields fall back to the standing-at-origin defaults.
 *
 * @param init Optional partial overrides for the initial state.
 * @returns A fresh, fully-populated `MoveState` (never shares references with `init`).
 */
export function createMoveState(init?: Partial<MoveState>): MoveState {
  return {
    x: init?.x ?? 0,
    y: init?.y ?? 0,
    z: init?.z ?? 0,
    yaw: init?.yaw ?? 0,
    vy: init?.vy ?? 0,
    grounded: init?.grounded ?? true,
    crawling: init?.crawling ?? false,
  };
}

/* -------------------------------------------------------------------------- */
/* Speed                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Horizontal speed (m/s) implied by the held keys plus the `crawling` flag.
 *
 * Priority is crawl < walk < run: crawling always wins (you cannot sprint while
 * low-profile), otherwise holding Run sprints, otherwise you walk.
 *
 * @param keys     Held-key bitmask.
 * @param crawling Whether the entity is in latched crawl mode.
 * @returns One of {@link MOVE_SPEED_CRAWL}, {@link MOVE_SPEED_RUN}, or {@link MOVE_SPEED_WALK}.
 */
export function moveSpeed(keys: number, crawling: boolean): number {
  if (crawling) return MOVE_SPEED_CRAWL;
  if (hasKey(keys, InputKey.Run)) return MOVE_SPEED_RUN;
  return MOVE_SPEED_WALK;
}

/* -------------------------------------------------------------------------- */
/* Step                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Advance one entity by a single FIXED timestep `dt` (seconds).
 *
 * PURE: returns a NEW {@link MoveState} and never mutates `state` or `input`.
 * Deterministic and framerate-independent — identical `(state, input, dt)`
 * always yields an identical result. Does NOT resolve world collision
 * (buildings/perimeter); the caller clamps the returned XZ afterward.
 *
 * Semantics, in order:
 *  1. Facing: the server trusts the client's look yaw, so `yaw = input.yaw`.
 *  2. Crawl latch: crawl mode may only change while grounded (no mid-air state
 *     changes); airborne, the previous `crawling` value is preserved.
 *  3. Horizontal: build a yaw-relative move vector from the held direction keys,
 *     normalize it so diagonals aren't faster, scale by {@link moveSpeed}·dt.
 *  4. Vertical: jump impulse (grounded only) -> gravity integration -> ground clamp.
 *
 * @param state Current kinematic state (read-only).
 * @param input Held keys + desired yaw for this tick (read-only).
 * @param dt    Fixed timestep in seconds.
 * @returns The next `MoveState`.
 */
export function step(state: MoveState, input: SimInput, dt: number): MoveState {
  const keys = input.keys;

  // 1. Facing — trust the client-reported look yaw.
  const yaw = input.yaw;

  // 2. Crawl latch — only (re)evaluate the crawl bit while on the ground so an
  //    airborne entity keeps whatever profile it left the ground with.
  const crawling = state.grounded ? hasKey(keys, InputKey.Crawl) : state.crawling;

  // 3. Horizontal movement (yaw-relative, on the XZ plane) --------------------
  // Local input axes: +f is forward, +s is strafe-right.
  const f = (hasKey(keys, InputKey.Forward) ? 1 : 0) - (hasKey(keys, InputKey.Back) ? 1 : 0);
  const s = (hasKey(keys, InputKey.Right) ? 1 : 0) - (hasKey(keys, InputKey.Left) ? 1 : 0);

  // Normalize the (f, s) vector when it has length so a diagonal (e.g. W+D)
  // isn't sqrt(2)x faster than a cardinal direction. A zero vector stays zero.
  let nf = f;
  let ns = s;
  const mag = Math.sqrt(f * f + s * s);
  if (mag > 0) {
    nf = f / mag;
    ns = s / mag;
  }

  // Rotate the normalized local vector into world space by the look yaw theta.
  //   Forward axis(theta) = (-sin, -cos)   Right axis(theta) = (cos, -sin)
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const worldDX = nf * -sinYaw + ns * cosYaw;
  const worldDZ = nf * -cosYaw + ns * -sinYaw;

  const speed = moveSpeed(keys, crawling);
  const x = state.x + worldDX * speed * dt;
  const z = state.z + worldDZ * speed * dt;

  // 4. Vertical movement (jump + gravity), integrated independently of XZ -----
  // Jump only launches from the ground; otherwise carry the existing velocity.
  let vy: number;
  if (state.grounded && hasKey(keys, InputKey.Jump)) {
    vy = JUMP_VELOCITY;
  } else {
    vy = state.vy;
  }

  // Semi-implicit Euler: apply gravity, then advance position by the new vy.
  vy -= GRAVITY * dt;
  let y = state.y + vy * dt;

  // Ground clamp: never fall below the ground plane; landing zeroes velocity.
  let grounded: boolean;
  if (y <= 0) {
    y = 0;
    vy = 0;
    grounded = true;
  } else {
    grounded = false;
  }

  // 5. Assemble the new state (no field of `state`/`input` was mutated).
  return { x, y, z, yaw, vy, grounded, crawling };
}
