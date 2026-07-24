/**
 * The Crawling Dark — NPC zombie AI (M4 · t4a "steering AI: seek + avoidance").
 *
 * A single "patient zero" NPC hunts the humans: it seeks the nearest human it
 * can perceive and steers around buildings using short look-ahead raycasts, so
 * it flows down the streets toward its prey instead of walking face-first into a
 * wall. The AI is intentionally *reactive steering*, not a planner — cheap,
 * stateless-per-tick movement that "just works" on the open street grid. The
 * known failure mode (getting wedged in a concave building pocket) is left for
 * the optional grid-A* upgrade (t4d).
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
  raycastBuildings,
  hasLineOfSight,
  type World,
} from '@crawling-dark/shared';
import type { Player } from './Player';

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
/* ZombieAI                                                                   */
/* -------------------------------------------------------------------------- */

/** Reactive steering brain for the NPC patient-zero zombie(s). */
export class ZombieAI {
  private readonly world: World;

  /** Per-NPC memory (target + LOS grace), keyed by NPC entity id. */
  private readonly state = new Map<number, AiState>();

  constructor(world: World) {
    this.world = world;
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
    // strands itself against the ring wall waiting for a target to appear.
    if (!target) {
      const desiredYaw = this.steer(npc, -npc.move.x, -npc.move.z);
      const idle = Math.hypot(npc.move.x, npc.move.z) < 6;
      return { targetId: null, desiredYaw, moving: !idle, running: false };
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
    void state;
    void dtMs;

    let nearest: Player | null = null;
    let nearestD2 = Infinity;
    for (const human of humans) {
      const dx = human.move.x - npc.move.x;
      const dz = human.move.z - npc.move.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearestD2) {
        nearestD2 = d2;
        nearest = human;
      }
    }
    return nearest;
  }

  /* ---------------------------------------------------------------------- */
  /* Steering (seek + building avoidance)                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Pick the best heading toward world direction `(dx, dz)` that keeps clear of
   * buildings. We fan {@link STEER_OFFSETS} candidate headings around the direct
   * line, cast an avoidance ray (inflated by the body radius) along each to
   * measure how far it is open, and choose the heading that maximises clearance
   * minus a {@link TURN_PENALTY} on deviation — i.e. go as straight at the prey
   * as the walls allow. Falls back to the raw heading if the target is
   * effectively on top of us.
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
      const clear = raycastBuildings(
        this.world,
        npc.move.x,
        npc.move.z,
        f.x,
        f.z,
        AI_AVOID_RAY_LENGTH,
        PLAYER_RADIUS,
      );
      const score = clear - Math.abs(off) * TURN_PENALTY;
      if (score > bestScore) {
        bestScore = score;
        bestYaw = yaw;
      }
    }
    return bestYaw;
  }

  /** Fetch (or lazily create) the persistent state record for one NPC. */
  private stateFor(npcId: number): AiState {
    let s = this.state.get(npcId);
    if (s === undefined) {
      s = { targetId: null, lostLosMs: 0 };
      this.state.set(npcId, s);
    }
    return s;
  }
}
