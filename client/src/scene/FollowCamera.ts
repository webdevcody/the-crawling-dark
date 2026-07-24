/**
 * The Crawling Dark — third-person spring-arm follow camera (M2 · t2e).
 *
 * A "spring arm" is the standard third-person camera rig: imagine a rigid arm
 * bolted to a pivot near the player's head that holds the camera a fixed
 * `distance` behind (and slightly to the side of) the player. Two behaviours
 * make it feel good rather than robotic:
 *
 *   1. **Smoothing** — the camera never teleports to its ideal spot; it is
 *      exponentially damped toward it each frame, so quick turns and stutters in
 *      the followed target read as a smooth glide instead of a snap.
 *   2. **Collision-aware retraction** — if a wall or building would sit between
 *      the pivot (the head) and the ideal camera spot, the arm *retracts* so the
 *      camera slides in front of the obstruction. Without this the camera would
 *      punch through geometry and you'd be staring at the inside of a wall — the
 *      one thing the acceptance criteria forbid ("never ends up inside a
 *      building").
 *
 * The rig is deliberately self-contained: it owns nothing but the passed-in
 * `THREE.PerspectiveCamera` and a couple of scratch vectors, and it reads the
 * world purely to raycast against building footprints. It never mutates the
 * `World`. `main.ts` constructs one of these, drops the fixed overhead camera,
 * and calls {@link FollowCamera.update} once per frame with the local player's
 * feet position, the mouse-driven look yaw, the town, and the frame delta.
 *
 * Yaw convention (MUST match the shared sim in `shared/src/sim.ts`, otherwise
 * the camera and the direction the player actually walks would disagree):
 *
 *   forward(yaw)  = (-sin(yaw), 0, -cos(yaw))   // at yaw = 0 forward is -Z
 *   right(yaw)    = ( cos(yaw), 0, -sin(yaw))
 *   backward(yaw) = -forward(yaw)
 *
 * All units are meters, matching the rest of the project.
 */

import * as THREE from 'three';
import { buildingAABB, type World } from '@crawling-dark/shared';

/* -------------------------------------------------------------------------- */
/* Tuning defaults & internal constants                                       */
/* -------------------------------------------------------------------------- */

/** Spring-arm defaults, applied when the caller omits an option. */
const DEFAULTS = {
  /** Ideal arm length behind the player, in meters. */
  distance: 5,
  /** Pivot height above the player's feet (≈ shoulder/head height), in meters. */
  height: 1.6,
  /** Lateral over-the-shoulder offset (to the player's right), in meters. */
  shoulder: 0.6,
  /** Position-smoothing rate; higher = snappier. Used as `1 - exp(-k·dt)`. */
  stiffness: 12,
  /** Closest the arm may ever retract to on a collision, in meters. */
  minDistance: 1.2,
} as const;

/**
 * Clearance (meters) kept between the camera and any surface it retracts
 * against. Pulling in to *exactly* the hit point would leave the near clip plane
 * grazing (and often poking through) the wall; backing off by this "skin" keeps
 * the lens comfortably clear of the geometry.
 */
const COLLISION_SKIN = 0.2;

/**
 * How far (meters) the camera is lifted above the pivot at full extension, so it
 * looks gently *down* at the player rather than dead level. Folded into the
 * desired offset, so the collision raycast accounts for it too.
 */
const DOWNWARD_LIFT = 0.4;

/**
 * Hard floor (meters) for the camera's Y. Even after retraction/smoothing the
 * lens must never dip below this, or it would clip under the ground plane.
 */
const MIN_CAMERA_Y = 0.3;

/** Direction components smaller than this are treated as axis-parallel. */
const EPSILON = 1e-6;

/* -------------------------------------------------------------------------- */
/* FollowCamera                                                               */
/* -------------------------------------------------------------------------- */

export class FollowCamera {
  private readonly camera: THREE.PerspectiveCamera;

  private readonly distance: number;
  private readonly height: number;
  private readonly shoulder: number;
  private readonly stiffness: number;
  private readonly minDistance: number;

  /**
   * False until the first {@link update}, so that very first frame snaps the
   * camera straight to its ideal pose instead of lerping in from wherever the
   * camera happened to be (e.g. the origin) — no jarring "fly-in".
   */
  private initialized = false;

  // Scratch vectors reused every frame to avoid per-frame allocation. They hold
  // no state between calls; each `update` fully overwrites them.
  private readonly pivot = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly targetPos = new THREE.Vector3();

  /**
   * @param camera  The perspective camera this rig drives. Ownership of its
   *                transform is handed to the rig; do not also set it elsewhere.
   * @param options Optional tuning overrides (see {@link DEFAULTS}):
   *                - `distance`    ideal arm length behind the player (5)
   *                - `height`      pivot height above the feet (1.6)
   *                - `shoulder`    lateral over-the-shoulder offset (0.6)
   *                - `stiffness`   smoothing rate, higher = snappier (12)
   *                - `minDistance` closest the arm may retract to (1.2)
   */
  constructor(
    camera: THREE.PerspectiveCamera,
    options: {
      distance?: number;
      height?: number;
      shoulder?: number;
      stiffness?: number;
      minDistance?: number;
    } = {},
  ) {
    this.camera = camera;
    this.distance = options.distance ?? DEFAULTS.distance;
    this.height = options.height ?? DEFAULTS.height;
    this.shoulder = options.shoulder ?? DEFAULTS.shoulder;
    this.stiffness = options.stiffness ?? DEFAULTS.stiffness;
    this.minDistance = options.minDistance ?? DEFAULTS.minDistance;
  }

  /**
   * Advance the camera one frame.
   *
   * Steps:
   *  1. Build the **pivot** at the player's head: `(x, y + height, z)`.
   *  2. Build the **desired** camera position: pivot, pushed backward along the
   *     look yaw by `distance`, nudged to the player's right by `shoulder`, and
   *     lifted by {@link DOWNWARD_LIFT} for a slight downward gaze.
   *  3. **Retract for collisions**: raycast pivot → desired against every
   *     building box; if something is in the way, pull the camera in to just
   *     shy of the nearest hit (never closer than `minDistance`).
   *  4. **Smooth**: exponentially damp the camera toward that corrected target
   *     (framerate-independent), except on the first frame which snaps.
   *  5. Aim at the pivot and clamp the camera above the ground floor.
   *
   * @param target The local player's FEET position in world space.
   * @param yaw    Look yaw in radians (forward at yaw = 0 is -Z; matches sim).
   * @param world  The town, used to shorten the arm around obstacles.
   * @param dt     Frame delta in seconds (for framerate-independent smoothing).
   */
  update(
    target: { x: number; y: number; z: number },
    yaw: number,
    world: World,
    dt: number,
  ): void {
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);

    // forward(yaw) = (-sin, 0, -cos); backward = -forward = (sin, 0, cos).
    // right(yaw)   = ( cos, 0, -sin).
    const backX = sin;
    const backZ = cos;
    const rightX = cos;
    const rightZ = -sin;

    // 1. Pivot — roughly the player's head, the point we orbit and look at.
    this.pivot.set(target.x, target.y + this.height, target.z);

    // 2. Desired camera position at full arm extension: behind + shoulder + lift.
    this.desired.set(
      this.pivot.x + backX * this.distance + rightX * this.shoulder,
      this.pivot.y + DOWNWARD_LIFT,
      this.pivot.z + backZ * this.distance + rightZ * this.shoulder,
    );

    // 3. Collision-aware arm length. Cast from the pivot toward `desired`; if a
    //    building box is in the way, retract to just before it.
    this.dir.subVectors(this.desired, this.pivot);
    const armLength = this.dir.length();
    if (armLength > EPSILON) {
      // Normalize the ray direction in place.
      this.dir.multiplyScalar(1 / armLength);

      const hit = this.nearestHitDistance(this.pivot, this.dir, armLength, world);
      if (hit < armLength) {
        // Back off by the skin, but never retract past the minimum arm length.
        const corrected = Math.max(this.minDistance, hit - COLLISION_SKIN);
        this.targetPos.copy(this.pivot).addScaledVector(this.dir, corrected);
      } else {
        this.targetPos.copy(this.desired);
      }
    } else {
      // Degenerate arm (should never happen): fall back to the pivot itself.
      this.targetPos.copy(this.pivot);
    }

    // Never let the target dip under the ground.
    if (this.targetPos.y < MIN_CAMERA_Y) this.targetPos.y = MIN_CAMERA_Y;

    // 4. Smoothing. On the first frame snap directly so we don't fly in from the
    //    camera's previous (e.g. origin) position; thereafter exponentially damp.
    if (!this.initialized) {
      this.camera.position.copy(this.targetPos);
      this.initialized = true;
    } else {
      // Framerate-independent critically-damped-style approach: the fraction of
      // the remaining gap closed this frame depends only on stiffness and dt,
      // never on the frame rate.
      const alpha = 1 - Math.exp(-this.stiffness * dt);
      this.camera.position.lerp(this.targetPos, alpha);
    }

    // 5. Re-clamp after smoothing (defensive) and aim at the pivot.
    if (this.camera.position.y < MIN_CAMERA_Y) {
      this.camera.position.y = MIN_CAMERA_Y;
    }
    this.camera.lookAt(this.pivot);
  }

  /* ------------------------------------------------------------------------ */
  /* Collision raycast                                                        */
  /* ------------------------------------------------------------------------ */

  /**
   * Nearest distance along the ray `origin + dir·t` (with `dir` unit-length, `t`
   * in `[0, maxDist]`) at which it first enters any building box, or `maxDist`
   * if the whole segment is clear.
   *
   * Each building is treated as a full 3D box: its XZ footprint (from
   * {@link buildingAABB}) extruded on Y over `[0, height]`. We use the classic
   * slab method per box — intersect the ray against each axis's near/far planes
   * and keep the overlapping `t` interval — which naturally handles the pivot
   * starting *inside* a box (returns entry `t = 0`, retracting fully) and rays
   * running parallel to a face.
   *
   * @param origin  Ray start (the pivot).
   * @param dir     Unit-length ray direction (pivot → desired).
   * @param maxDist Segment length; hits beyond it are ignored.
   * @param world   The town whose `buildings` are the colliders.
   */
  private nearestHitDistance(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    world: World,
  ): number {
    let nearest = maxDist;

    for (const building of world.buildings) {
      const box = buildingAABB(building);
      const t = FollowCamera.slabHit(
        origin,
        dir,
        nearest,
        box.minX,
        box.maxX,
        0,
        building.height,
        box.minZ,
        box.maxZ,
      );
      if (t < nearest) nearest = t;
    }

    return nearest;
  }

  /**
   * Slab-method ray/AABB intersection. Returns the entry distance `t ∈ [0, max]`
   * where `origin + dir·t` first crosses into the box, or `max` when the segment
   * misses it (so callers can treat "no hit" as "the box is at/after the current
   * nearest").
   *
   * The interval `[tmin, tmax]` starts as `[0, max]` and is clipped by each
   * axis's pair of slab planes. A near-zero direction component means the ray is
   * parallel to that axis's slabs, so it can only hit if the origin already lies
   * between them; otherwise there is no intersection.
   */
  private static slabHit(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    max: number,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number,
  ): number {
    let tmin = 0;
    let tmax = max;

    // X slab.
    if (Math.abs(dir.x) < EPSILON) {
      if (origin.x < minX || origin.x > maxX) return max;
    } else {
      const inv = 1 / dir.x;
      let t1 = (minX - origin.x) * inv;
      let t2 = (maxX - origin.x) * inv;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return max;
    }

    // Y slab (building extruded over [0, height]).
    if (Math.abs(dir.y) < EPSILON) {
      if (origin.y < minY || origin.y > maxY) return max;
    } else {
      const inv = 1 / dir.y;
      let t1 = (minY - origin.y) * inv;
      let t2 = (maxY - origin.y) * inv;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return max;
    }

    // Z slab.
    if (Math.abs(dir.z) < EPSILON) {
      if (origin.z < minZ || origin.z > maxZ) return max;
    } else {
      const inv = 1 / dir.z;
      let t1 = (minZ - origin.z) * inv;
      let t2 = (maxZ - origin.z) * inv;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return max;
    }

    // Overlapping interval exists within [0, max] → entry distance is tmin.
    return tmin;
  }
}
