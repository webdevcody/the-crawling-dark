/**
 * The Crawling Dark — NPC zombie AI (M4 · t4a "steering AI: seek + avoidance").
 *
 * A single "patient zero" NPC hunts the humans: it seeks the nearest human it
 * can perceive and steers around buildings using short look-ahead raycasts, so
 * it flows down the streets toward its prey instead of walking face-first into a
 * wall. The AI is intentionally *reactive steering* first — cheap,
 * near-stateless movement that "just works" on the open street grid — with a
 * grid-A* planner (t4d) layered on only as a fallback: when reactive steering
 * demonstrably stalls (wedged in a concave building pocket, or a building parked
 * squarely between the NPC and its prey), the NPC plans a path around the
 * obstacle and follows it waypoint by waypoint until it can see its quarry
 * again. See {@link NavGrid} and {@link ZombieAI.follow}.
 *
 * Separation of concerns:
 *   - This module decides WHERE the NPC wants to go (a target + a steered
 *     heading) and hands the {@link Room} a {@link ZombieIntent}; the Room owns
 *     the actual position integration and collision (so the NPC resolves against
 *     the town exactly like a player does).
 *   - {@link ZombieAI.acquireTarget} is the target-acquisition seam. t4a ships a
 *     simple "nearest human" pick; t4b replaces its body with line-of-sight +
 *     crawl-stealth detection and a lost-target grace period — everything that
 *     work needs (the world, per-NPC {@link AiState}, detection constants) is
 *     already threaded through here.
 *   - Wiring the NPC's contact attack into the infection system is t4c, and
 *     lives in the Room (see `Room.decideNpcAttack`), so it never collides with
 *     the targeting work here.
 *
 * The server is authoritative and simply broadcasts the NPC's resulting position
 * in snapshots, so — unlike the shared movement `sim` — this AI does NOT need to
 * be deterministic across client and server; only the server ever runs it.
 */

import {
  PLAYER_RADIUS,
  AI_AVOID_RAY_LENGTH,
  AI_DETECTION_RADIUS,
  AI_CRAWL_DETECTION_MULT,
  AI_LOS_GRACE_MS,
  NPC_CHASE_SPEED,
  AI_STALL_ENGAGE_MS,
  AI_STALL_PROGRESS_FRAC,
  AI_REPATH_INTERVAL_MS,
  raycastBuildings,
  hasLineOfSight,
  type World,
} from '@crawling-dark/shared';
import type { Player } from './Player';
import { NavGrid, type Waypoint } from './navgrid';

/* -------------------------------------------------------------------------- */
/* Intent + per-NPC state                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the AI wants one NPC to do this tick. The {@link Room} turns this into
 * motion: face `desiredYaw`, and when `moving`, advance at the chase speed
 * (`running`) or the slow patrol speed, resolving collision afterward.
 */
export interface ZombieIntent {
  /** The human entity id currently being hunted, or `null` when patrolling. */
  targetId: number | null;
  /** World facing (radians) the NPC should turn to and travel along this tick. */
  desiredYaw: number;
  /** Whether the NPC should move at all this tick (false ⇒ hold position). */
  moving: boolean;
  /** True to hunt at chase speed; false to prowl at the slower patrol speed. */
  running: boolean;
}

/**
 * Small mutable memory the AI keeps per NPC between ticks, keyed by NPC id in
 * {@link ZombieAI}. t4b leans on this to remember a target across brief
 * line-of-sight breaks (the `lostLosMs` grace timer).
 */
export interface AiState {
  /** Currently-hunted human id, or `null` when the NPC has no quarry. */
  targetId: number | null;
  /** Milliseconds since the NPC last had a clear line of sight to its target. */
  lostLosMs: number;

  /* --- t4d: A* fallback bookkeeping ------------------------------------- */
  /** Accumulated ms of "no progress" while chasing; arms the A* fallback. */
  stallMs: number;
  /** NPC XZ sampled last tick, used to measure how far it actually moved. */
  prevX: number;
  prevZ: number;
  /** False until the first sample exists, so tick one is never a false stall. */
  havePrev: boolean;
  /** Active A* route (world-space waypoints), or `null` when steering directly. */
  path: Waypoint[] | null;
  /** Index of the current waypoint within {@link path}. */
  pathIndex: number;
  /** Milliseconds since {@link path} was last recomputed. */
  repathMs: number;
  /** Target position the live {@link path} was planned toward (for re-plan). */
  pathGoalX: number;
  pathGoalZ: number;
}

/* -------------------------------------------------------------------------- */
/* Steering tunables (local to the AI)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Candidate heading offsets (radians) probed each tick when steering toward the
 * target: dead ahead first, then progressively wider fans to either side. The
 * NPC casts an avoidance ray along each and picks the most open one, biased back
 * toward straight-line pursuit by {@link TURN_PENALTY}.
 */
const STEER_OFFSETS = [
  0,
  Math.PI / 7, // ~25.7°
  -Math.PI / 7,
  Math.PI / 4, // 45°
  -Math.PI / 4,
  Math.PI / 2.5, // 72°
  -Math.PI / 2.5,
  (Math.PI * 3) / 4, // 135° — last-ditch sidestep along a wall
  -(Math.PI * 3) / 4,
];

/**
 * Clearance (meters) subtracted per radian of deviation from the straight line
 * to the target, so the NPC only swings wide when a closer heading is genuinely
 * blocked. Tuned so a ~90° detour must buy real room to be chosen.
 */
const TURN_PENALTY = AI_AVOID_RAY_LENGTH / (Math.PI / 2);

/* -------------------------------------------------------------------------- */
/* Heading helpers (shared with the Room's NPC integration)                   */
/* -------------------------------------------------------------------------- */

/**
 * Unit forward vector for a facing `yaw`, matching the shared sim's convention
 * (`forward = (-sin yaw, -cos yaw)`; yaw 0 faces −Z). The Room advances the NPC
 * along exactly this axis, so movement and facing never disagree.
 */
export function forwardFromYaw(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/**
 * Inverse of {@link forwardFromYaw}: the `yaw` whose forward vector points along
 * the (not-necessarily-unit) world direction `(dx, dz)`.
 */
export function yawFromDir(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/* -------------------------------------------------------------------------- */
/* Ray / segment vs circle (server-local — trees + lake perception, t9f)      */
/* -------------------------------------------------------------------------- */

/**
 * Ray-vs-circle on the XZ plane: cast from `(ox, oz)` along the UNIT direction
 * `(dx, dz)` and return the distance to the first intersection with the disc
 * centred at `(cx, cz)` of radius `r`, or `null` when the ray misses (or the disc
 * lies wholly behind the origin). This mirrors the shared {@link rayAABB}
 * contract for the new circular obstacles: the disc is the tree/lake collider
 * (already inflated by the body radius for avoidance, or bare for a sightline),
 * and an origin already inside it reports distance `0`.
 *
 * Solves the quadratic |o + t·d − c|² = r² with `d` unit (so the `t²` coefficient
 * is 1): with `f = o − c`, `b = f·d`, `c₀ = f·f − r²`, the nearer root is
 * `−b − √(b² − c₀)`. `c₀ ≤ 0` means the origin sits inside the disc; `b > 0` means
 * the centre is behind the ray, so any hit would be at negative `t` — both are
 * short-circuited before the `sqrt`.
 */
function rayCircle(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  cx: number,
  cz: number,
  r: number,
): number | null {
  const fx = ox - cx;
  const fz = oz - cz;
  const c0 = fx * fx + fz * fz - r * r;
  if (c0 <= 0) return 0; // origin already inside the disc → contact at distance 0
  const b = fx * dx + fz * dz; // f·d (the direction is unit, so a == 1)
  if (b > 0) return null; // disc centre is behind the ray — no forward hit
  const disc = b * b - c0;
  if (disc < 0) return null; // ray passes wide of the disc
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* ZombieAI                                                                   */
/* -------------------------------------------------------------------------- */

/** Reactive steering brain for the NPC patient-zero zombie(s). */
export class ZombieAI {
  private readonly world: World;

  /**
   * Occupancy grid + A* for the {@link follow} fallback, built once from the
   * town. Server-only and never networked (see {@link NavGrid}).
   */
  private readonly nav: NavGrid;

  /** Per-NPC memory (target, LOS grace, stall + path state), keyed by NPC id. */
  private readonly state = new Map<number, AiState>();

  constructor(world: World) {
    this.world = world;
    this.nav = new NavGrid(world);
  }

  /**
   * Decide one NPC's movement for a single tick.
   *
   * @param npc      The NPC zombie to steer.
   * @param humans   Live, infectable human candidates (non-spectator, team
   *                 'human', not downed). The AI never targets zombies.
   * @param dtMs     Fixed tick length in milliseconds (feeds the grace timer).
   */
  update(npc: Player, humans: readonly Player[], dtMs: number): ZombieIntent {
    const state = this.stateFor(npc.id);

    const target = this.acquireTarget(npc, humans, state, dtMs);
    state.targetId = target ? target.id : null;

    // No prey in reach → prowl slowly toward the town centre so the NPC never
    // strands itself against the ring wall waiting for a target to appear. Any
    // in-progress A* plan is abandoned here — there is nothing to path to.
    if (!target) {
      this.abandonPath(state);
      this.trackProgress(npc, state, false, dtMs);
      const desiredYaw = this.steer(npc, -npc.move.x, -npc.move.z);
      const idle = Math.hypot(npc.move.x, npc.move.z) < 6;
      return { targetId: null, desiredYaw, moving: !idle, running: false };
    }

    // Measure whether last tick's chase actually gained ground; a long enough run
    // of no-progress ticks is what arms the A* fallback below (t4d). A stunned
    // NPC is held still on purpose, so its non-movement never counts as a stall.
    const chasing = !npc.isStunned;
    this.trackProgress(npc, state, chasing, dtMs);

    // A* fallback: engaged (a live `path`) or newly armed by a sustained stall.
    // While a plan is live we follow it around the obstacle; {@link follow}
    // returns null the instant a clear line to the target reappears (or the route
    // is spent / unreachable), dropping us back to cheap reactive steering.
    if (state.path !== null || state.stallMs >= AI_STALL_ENGAGE_MS) {
      const yaw = this.follow(npc, target, state, dtMs);
      if (yaw !== null) {
        return { targetId: target.id, desiredYaw: yaw, moving: true, running: true };
      }
    }

    // Seek: steer the straight-line pursuit heading around any buildings.
    const dx = target.move.x - npc.move.x;
    const dz = target.move.z - npc.move.z;
    const desiredYaw = this.steer(npc, dx, dz);
    return { targetId: target.id, desiredYaw, moving: true, running: true };
  }

  /** The current hunted human id for an NPC, or `null` (read by the Room/t4c). */
  getTargetId(npcId: number): number | null {
    return this.state.get(npcId)?.targetId ?? null;
  }

  /** Drop an NPC's remembered state (call if an NPC is ever removed). */
  forget(npcId: number): void {
    this.state.delete(npcId);
  }

  /* ---------------------------------------------------------------------- */
  /* Target acquisition — t4b EXTENSION POINT                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Choose which human this NPC hunts this tick.
   *
   * t4a baseline: the nearest live human, unconditionally — enough to prove the
   * seek-and-steer loop navigates streets toward prey.
   *
   * t4b replaces this body with true perception: only humans within the
   * (crawl-adjusted) {@link AI_DETECTION_RADIUS} that also have a clear
   * {@link hasLineOfSight}, sticky targeting that keeps the current quarry until
   * {@link AI_LOS_GRACE_MS} of unbroken occlusion elapses, then re-acquires the
   * nearest visible human. All the inputs it needs — the world, the per-NPC
   * {@link AiState} (`state.lostLosMs`), and the detection constants — are
   * already imported and threaded here, so that work stays wholly inside this
   * file and never touches the Room or the steering code below.
   */
  private acquireTarget(
    npc: Player,
    humans: readonly Player[],
    state: AiState,
    dtMs: number,
  ): Player | null {
    // --- Sticky pursuit: try to hold onto the human we're already hunting. ---
    // Committing to one quarry (rather than re-picking the nearest every tick)
    // gives stable, readable chases and lets the grace timer below bridge brief
    // sight breaks.
    if (state.targetId !== null) {
      const current = humans.find((h) => h.id === state.targetId) ?? null;
      if (current === null) {
        // Quarry left the live set (disconnected / downed / turned zombie).
        // There's nothing to pursue, so drop it and re-acquire below.
      } else if (this.isVisible(npc, current)) {
        // Still in plain sight: refresh the grace timer and stay locked on, even
        // if some other human is momentarily closer. Chasing whoever is nearest
        // each tick makes the NPC dither whenever two humans cross paths.
        state.lostLosMs = 0;
        return current;
      } else {
        // Lost sight this tick. Keep pursuing its last-known position until the
        // grace period is spent, so a human who ducks behind a wall for a beat
        // doesn't instantly shake the hunter.
        state.lostLosMs += dtMs;
        if (state.lostLosMs <= AI_LOS_GRACE_MS) return current;
        // Grace exhausted — the trail's gone cold; fall through and re-acquire.
      }
    }

    // --- Acquire: the nearest human this NPC can actually perceive right now. ---
    let best: Player | null = null;
    let bestD2 = Infinity;
    for (const human of humans) {
      if (!this.isVisible(npc, human)) continue;
      const dx = human.move.x - npc.move.x;
      const dz = human.move.z - npc.move.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = human;
      }
    }
    // A fresh lock (or an empty scan) starts with a clean grace timer: it only
    // ever measures unbroken occlusion of a *held* target, never the search.
    state.lostLosMs = 0;
    return best;
  }

  /**
   * Whether the NPC can perceive `human` this instant — the atomic test behind
   * both sticky pursuit and re-acquisition. A human is visible only when it is
   * within its own detection radius AND no building occludes the sightline.
   *
   * The radius shrinks for a crawling human ({@link AI_CRAWL_DETECTION_MULT}),
   * which — together with the {@link hasSight} occlusion check — is what makes
   * the acceptance criterion hold: a crawler behind cover is spotted far less
   * readily than someone running upright in the open, because it must be both
   * much closer (smaller radius) and in an unbroken line of sight past buildings
   * AND trees.
   */
  private isVisible(npc: Player, human: Player): boolean {
    const radius =
      human.move.crawling === true
        ? AI_DETECTION_RADIUS * AI_CRAWL_DETECTION_MULT
        : AI_DETECTION_RADIUS;
    const dx = human.move.x - npc.move.x;
    const dz = human.move.z - npc.move.z;
    if (dx * dx + dz * dz > radius * radius) return false;
    return this.hasSight(npc.move.x, npc.move.z, human.move.x, human.move.z);
  }

  /* ---------------------------------------------------------------------- */
  /* Steering (seek + building avoidance)                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Pick the best heading toward world direction `(dx, dz)` that keeps clear of
   * every obstacle. We fan {@link STEER_OFFSETS} candidate headings around the
   * direct line, cast an avoidance ray (inflated by the body radius) along each to
   * measure how far it is open, and choose the heading that maximises clearance
   * minus a {@link TURN_PENALTY} on deviation — i.e. go as straight at the prey as
   * the world allows. Falls back to the raw heading if the target is effectively
   * on top of us.
   *
   * Per-heading clearance is the nearest hit of ALL obstacle kinds: buildings
   * (shared AABB cast) narrowed by trees and the lake ({@link raycastNature}), so
   * the NPC steers around trunks and water exactly as it does around walls.
   */
  private steer(npc: Player, dx: number, dz: number): number {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return npc.move.yaw;

    const baseYaw = yawFromDir(dx, dz);
    let bestYaw = baseYaw;
    let bestScore = -Infinity;

    for (const off of STEER_OFFSETS) {
      const yaw = baseYaw + off;
      const f = forwardFromYaw(yaw);
      // Building clearance first (capped at the ray length), then let trees + the
      // lake only pull it shorter, so `clear` is MIN(building, nearest tree, lake).
      const buildingClear = raycastBuildings(
        this.world,
        npc.move.x,
        npc.move.z,
        f.x,
        f.z,
        AI_AVOID_RAY_LENGTH,
        PLAYER_RADIUS,
      );
      const clear = this.raycastNature(npc.move.x, npc.move.z, f.x, f.z, buildingClear);
      const score = clear - Math.abs(off) * TURN_PENALTY;
      if (score > bestScore) {
        bestScore = score;
        bestYaw = yaw;
      }
    }
    return bestYaw;
  }

  /**
   * Distance along the ray from `(ox, oz)` in UNIT direction `(dx, dz)` at which
   * it first strikes a tree trunk or the (blocked) lake shoreline, or `maxDist`
   * when it reaches that far clear of both. Passing the building hit distance in
   * as `maxDist` makes this the min-clearance combiner for {@link steer}: it only
   * ever returns something shorter. Each disc is inflated by {@link PLAYER_RADIUS}
   * to match the building `pad`, so the NPC keeps a body width off trunks/water.
   *
   * Only one NPC runs this, so a per-heading pass over ~740 trees is affordable —
   * but each tree is bound-culled first: if its centre is farther than the current
   * `nearest` clearance plus its inflated radius, no point on it can be struck
   * within the ray, so it is skipped before the quadratic. `nearest` shrinks as
   * closer hits are found, tightening the cull as the scan proceeds.
   */
  private raycastNature(
    ox: number,
    oz: number,
    dx: number,
    dz: number,
    maxDist: number,
  ): number {
    let nearest = maxDist;
    const trees = this.world.trees;
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      const inflated = t.radius + PLAYER_RADIUS;
      const gx = t.x - ox;
      const gz = t.z - oz;
      const cull = nearest + inflated;
      if (gx * gx + gz * gz > cull * cull) continue; // cannot be hit within `nearest`
      const hit = rayCircle(ox, oz, dx, dz, t.x, t.z, inflated);
      if (hit !== null && hit < nearest) nearest = hit;
    }
    const w = this.world.water;
    if (w !== null && this.world.waterMode === 'blocked') {
      const hit = rayCircle(ox, oz, dx, dz, w.cx, w.cz, w.radius + PLAYER_RADIUS);
      if (hit !== null && hit < nearest) nearest = hit;
    }
    return nearest;
  }

  /**
   * Line of sight for perception (t9f): the segment from `(x0, z0)` to `(x1, z1)`
   * is clear only when the shared {@link hasLineOfSight} finds no BUILDING across
   * it AND no tree trunk straddles it. Trees occlude; the lake deliberately does
   * NOT — open water is see-through, so a human across the shoreline can still be
   * spotted, and the lake is never tested here.
   *
   * Trees are cast bare (no body pad — a sightline is a ray, not the NPC's
   * cylinder) and bound-culled by the segment length before the segment-vs-circle
   * test. A trunk counts as occluding only when it is struck strictly before the
   * far endpoint (matching the shared LoS epsilon), so a human standing right at a
   * trunk's edge is still just visible.
   */
  private hasSight(x0: number, z0: number, x1: number, z1: number): boolean {
    // Buildings first (shared cast) — the cheap, common blocker.
    if (!hasLineOfSight(this.world, x0, z0, x1, z1)) return false;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-6) return true;
    const ux = dx / dist;
    const uz = dz / dist;
    const trees = this.world.trees;
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      const gx = t.x - x0;
      const gz = t.z - z0;
      const cull = dist + t.radius;
      if (gx * gx + gz * gz > cull * cull) continue; // too far from the origin to cross
      const hit = rayCircle(x0, z0, ux, uz, t.x, t.z, t.radius);
      if (hit !== null && hit < dist - 1e-4) return false; // trunk between the points
    }
    return true; // no building and no tree occludes the sightline
  }

  /* ---------------------------------------------------------------------- */
  /* A* fallback (t4d) — engaged only when reactive steering stalls          */
  /* ---------------------------------------------------------------------- */

  /**
   * Update the per-NPC stall accumulator from how far it actually moved since the
   * previous tick — the sole trigger for the A* fallback. While `chasing`, a tick
   * that advances less than {@link AI_STALL_PROGRESS_FRAC} of the ground a clear
   * run at {@link NPC_CHASE_SPEED} would cover is a stall (its `dtMs` adds to
   * `stallMs`); a productive tick, or any tick not spent chasing (stunned, no
   * target), resets it. The NPC's position is sampled here for next tick's
   * comparison.
   *
   * Note the measurement is honest by construction: the {@link Room} integrates
   * the NPC *after* this runs, so the displacement observed here is exactly the
   * motion the previous tick's intent produced against real collision — if a wall
   * ate the move, it shows up as a stall.
   */
  private trackProgress(
    npc: Player,
    state: AiState,
    chasing: boolean,
    dtMs: number,
  ): void {
    if (state.havePrev && chasing) {
      const moved = Math.hypot(npc.move.x - state.prevX, npc.move.z - state.prevZ);
      const expected = NPC_CHASE_SPEED * (dtMs / 1000);
      if (moved < expected * AI_STALL_PROGRESS_FRAC) state.stallMs += dtMs;
      else state.stallMs = 0;
    } else {
      state.stallMs = 0;
    }
    state.prevX = npc.move.x;
    state.prevZ = npc.move.z;
    state.havePrev = true;
  }

  /**
   * Drive the NPC along an A* plan around whatever blocks the direct chase.
   * Returns the steered yaw toward the current waypoint, or `null` to mean
   * "abandon the plan and steer directly" — which happens on a clear shot at the
   * target, a fully-consumed route, or an unreachable target.
   *
   * The route is (re)planned when first engaging, when it expires
   * ({@link AI_REPATH_INTERVAL_MS}), or when the target has drifted a cell or
   * more from where it was planned — so it tracks fleeing prey without replanning
   * every tick. Reached waypoints are popped as the NPC arrives, and each
   * surviving waypoint is still *approached via {@link steer}*, so body-radius
   * wall avoidance keeps happening between the coarse grid corners (the "fall
   * back to steering between waypoints" the task calls for).
   */
  private follow(
    npc: Player,
    target: Player,
    state: AiState,
    dtMs: number,
  ): number | null {
    // A clear straight line to the prey (no building AND no tree between) means the
    // obstacle is behind us: hand control back to reactive steering, which is
    // smoother than grid hops. The lake never blocks sight, so a route around the
    // shoreline is held by the stall/A* machinery, not dropped here.
    if (this.hasSight(npc.move.x, npc.move.z, target.move.x, target.move.z)) {
      this.abandonPath(state);
      return null;
    }

    state.repathMs += dtMs;
    const targetMoved =
      Math.hypot(target.move.x - state.pathGoalX, target.move.z - state.pathGoalZ) >
      this.nav.cell;
    if (state.path === null || state.repathMs >= AI_REPATH_INTERVAL_MS || targetMoved) {
      state.path = this.nav.findPath(
        npc.move.x,
        npc.move.z,
        target.move.x,
        target.move.z,
      );
      state.pathIndex = 0;
      state.repathMs = 0;
      state.pathGoalX = target.move.x;
      state.pathGoalZ = target.move.z;
      if (state.path === null) {
        // No route (target boxed in, or genuinely unreachable). Stop hammering
        // the planner every tick and let steering do its best from here.
        state.stallMs = 0;
        return null;
      }
    }

    const path = state.path;
    if (path === null) return null;

    // Pop waypoints already reached (within a cell). The final waypoint is the
    // target's own cell, so consuming it means we've effectively arrived.
    const arrive = this.nav.cell;
    while (state.pathIndex < path.length) {
      const wp = path[state.pathIndex];
      if (Math.hypot(wp.x - npc.move.x, wp.z - npc.move.z) <= arrive) state.pathIndex++;
      else break;
    }
    if (state.pathIndex >= path.length) {
      this.abandonPath(state);
      return null; // route consumed — we're on top of the target's cell.
    }

    const wp = path[state.pathIndex];
    return this.steer(npc, wp.x - npc.move.x, wp.z - npc.move.z);
  }

  /** Drop any active A* plan and clear the stall counter that armed it. */
  private abandonPath(state: AiState): void {
    state.path = null;
    state.pathIndex = 0;
    state.repathMs = 0;
    state.stallMs = 0;
  }

  /** Fetch (or lazily create) the persistent state record for one NPC. */
  private stateFor(npcId: number): AiState {
    let s = this.state.get(npcId);
    if (s === undefined) {
      s = {
        targetId: null,
        lostLosMs: 0,
        stallMs: 0,
        prevX: 0,
        prevZ: 0,
        havePrev: false,
        path: null,
        pathIndex: 0,
        repathMs: 0,
        pathGoalX: 0,
        pathGoalZ: 0,
      };
      this.state.set(npcId, s);
    }
    return s;
  }
}
