/**
 * The Crawling Dark — camera game-feel layer (M14 · t14c).
 *
 * This is the "juice" pass for the camera: the small, involuntary motions that
 * make impacts, sprints and landings *feel* like they hit. It owns nothing but
 * the passed-in {@link THREE.PerspectiveCamera} and a handful of scratch
 * objects, and it exposes three trigger verbs the game logic can fire off —
 * {@link addTrauma}, {@link kickFov} and {@link landingPunch} — plus a single
 * {@link apply} that folds all of them into the camera each frame.
 *
 * ── Why the offset is additive and NON-accumulating ──────────────────────────
 * The {@link FollowCamera} rig is authoritative over the camera transform: its
 * `update()` FULLY OVERWRITES `camera.position` and `camera.quaternion` every
 * frame ("each update fully overwrites them"). {@link apply} is therefore called
 * *immediately AFTER* `follow.update(...)`, and it merely ADDS a per-frame offset
 * on top of that fresh pose. Because the very next frame's `follow.update` wipes
 * the transform back to the clean follow pose before we add again, our offsets
 * can never accumulate or drift — each frame starts from zero. That is the whole
 * reason this class does not (and must not) try to remember or undo last frame's
 * offset.
 *
 * ── Trauma model (Nystrom-style) ─────────────────────────────────────────────
 * Rather than a dozen bespoke "shake N pixels for M ms" calls, callers pour
 * `trauma` into a single [0,1] reservoir via {@link addTrauma}. The actual shake
 * magnitude is `trauma²` — squaring means low trauma reads as a faint tremble and
 * only a full hit slams the lens, and the falloff feels natural as the reservoir
 * drains. Trauma bleeds off *linearly* (so it always reaches zero in bounded
 * time, unlike an exponential tail that lingers forever).
 *
 * The shake itself is driven by layered {@link Math.sin} over an internal time
 * accumulator with FIXED, mutually-distinct per-axis frequencies and phases — it
 * is fully deterministic and jitter-free. We deliberately avoid `Math.random`
 * per frame, which would produce a harsh 1-frame-white-noise buzz instead of the
 * smooth, weighty wobble we want.
 *
 * ── FOV kick & landing punch ─────────────────────────────────────────────────
 * {@link kickFov} shoves a decaying degrees offset onto the field of view (a
 * short "whump" of speed for a sprint start or a heavy hit), and
 * {@link landingPunch} drops the lens briefly and eases it back (the knees-bend
 * of touching down) while also topping up a little trauma.
 *
 * This class is camera-only: it NEVER touches the simulation / prediction `dt`,
 * and it allocates nothing per frame (all math reuses preallocated scratch
 * objects). All positional units are meters; rotational units are radians; FOV
 * units are degrees (matching Three.js).
 */

import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Tuning constants                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How fast the trauma reservoir drains, in trauma-units per second. At 1.2 /s a
 * full-trauma slam is visibly gone in a little under a second — long enough to
 * register, short enough not to overstay. Linear (not exponential) so it always
 * lands cleanly at zero.
 */
const TRAUMA_DECAY_PER_S = 1.2;

/**
 * Peak positional shake on X and Y at full effective magnitude (`trauma² = 1`),
 * in meters. Kept small — the lens should tremble, not lurch.
 */
const MAX_SHAKE_POS = 0.12;

/**
 * Peak positional shake on Z (dolly in/out) at full magnitude, in meters. Much
 * smaller than X/Y: a little breathing depth reads as weight, but too much just
 * makes the scene pump distractingly.
 */
const MAX_SHAKE_POS_Z = 0.04;

/**
 * Peak rotational shake per axis (roll / pitch / yaw) at full magnitude, in
 * radians (~1.15°). Rotation is what actually sells a shake — this is the star —
 * but past a couple of degrees it reads as nausea, so it stays tiny.
 */
const MAX_SHAKE_ROT = 0.02;

/**
 * Half-life of the FOV kick, in milliseconds: every {@link FOV_HALF_LIFE_MS} the
 * outstanding `fovOffset` halves. ~120 ms gives a punchy, near-instant snap-back.
 */
const FOV_HALF_LIFE_MS = 120;

/**
 * Below this magnitude (degrees) the decaying `fovOffset` is snapped to exactly
 * zero, so the FOV settles precisely on `baseFov` and {@link apply} can stop
 * touching the projection matrix once idle.
 */
const FOV_MIN_DEG = 0.01;

/**
 * Minimum FOV change (degrees) that justifies rebuilding the projection matrix.
 * When the target FOV differs from the camera's current FOV by less than this we
 * skip {@link THREE.PerspectiveCamera.updateProjectionMatrix} entirely — the
 * common idle case where nothing changed frame to frame.
 */
const FOV_APPLY_EPS = 1e-4;

/**
 * Duration of the landing dip, in milliseconds. "Brief": the lens drops and has
 * fully recovered within this window.
 */
const LANDING_DURATION_MS = 260;

/**
 * Peak downward dip of a full-strength landing, in meters. The camera never
 * dips further than this regardless of `strength` clamping upstream.
 */
const MAX_LANDING_DIP = 0.16;

/**
 * How much trauma a full-strength landing adds on top of the dip, so a heavy
 * touchdown also gets a faint shake. Scaled by the landing's `strength`.
 */
const LANDING_TRAUMA = 0.25;

/* --- Fixed noise frequencies (rad/s) & phases (rad). ----------------------- */
/* Distinct, non-harmonic per-axis values so the six channels never lock into  */
/* the same rhythm; each channel further layers a second, ~2.14× sine (see      */
/* `noise`) to break up the obvious single-sine sway into something organic.    */

const FREQ_POS_X = 47;
const FREQ_POS_Y = 59;
const FREQ_POS_Z = 41;
const FREQ_ROT_PITCH = 53;
const FREQ_ROT_YAW = 61;
const FREQ_ROT_ROLL = 43;

const PHASE_POS_X = 0.0;
const PHASE_POS_Y = 1.7;
const PHASE_POS_Z = 4.3;
const PHASE_ROT_PITCH = 2.9;
const PHASE_ROT_YAW = 5.1;
const PHASE_ROT_ROLL = 0.8;

/** Weights of the two layered sines; sum = 1 so `noise` stays within [-1, 1]. */
const NOISE_PRIMARY_WEIGHT = 0.6;
const NOISE_SECONDARY_WEIGHT = 0.4;
/** Frequency multiplier of the secondary sine layer (deliberately irrational-ish). */
const NOISE_SECONDARY_RATIO = 2.137;

/* -------------------------------------------------------------------------- */
/* CameraShake                                                                */
/* -------------------------------------------------------------------------- */

export class CameraShake {
  private readonly camera: THREE.PerspectiveCamera;

  /** The camera's resting field of view, captured at construction (degrees). */
  private readonly baseFov: number;

  /** Trauma reservoir in [0, 1]; shake magnitude is its square. */
  private trauma = 0;

  /** Outstanding, decaying FOV offset added to {@link baseFov} (degrees). */
  private fovOffset = 0;

  /** Milliseconds remaining in the current landing dip (0 = no dip active). */
  private landingTime = 0;
  /** Strength of the currently-playing landing dip (see {@link landingPunch}). */
  private landingStrength = 0;

  /**
   * Monotonic time accumulator feeding the noise sines, in seconds. Advanced by
   * the camera-frame delta only (never the sim dt). Doubles keep sin() accurate
   * far longer than any single session, so we do not bother wrapping it.
   */
  private time = 0;

  // Scratch objects reused every frame — this class allocates nothing in
  // `apply`. They carry no state between calls; each frame fully overwrites them.
  private readonly offset = new THREE.Vector3();
  private readonly euler = new THREE.Euler();
  private readonly quat = new THREE.Quaternion();

  /**
   * @param camera The perspective camera to juice. Its transform is assumed to
   *               be (re)written by {@link FollowCamera.update} each frame BEFORE
   *               {@link apply} is called; this class only adds on top.
   */
  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.baseFov = camera.fov;
  }

  /* ------------------------------------------------------------------------ */
  /* Triggers                                                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * Pour trauma into the reservoir. Values accumulate and clamp into [0, 1], so
   * repeated hits stack toward — but never past — a full-intensity shake. The
   * on-screen magnitude is `trauma²`, so e.g. 0.5 trauma is only a quarter-power
   * wobble.
   *
   * @param amount Trauma to add (typically ~0.2 for a light hit, ~0.6–1 for a
   *               heavy one). Negative values are allowed and simply drain.
   */
  addTrauma(amount: number): void {
    this.trauma = Math.max(0, Math.min(1, this.trauma + amount));
  }

  /**
   * Punch the field of view by a decaying offset. Positive widens the lens (the
   * classic speed/impact "whump"); it snaps back toward the resting FOV with a
   * ~{@link FOV_HALF_LIFE_MS} half-life. Repeated kicks stack.
   *
   * @param deltaDegrees Degrees to add to the outstanding FOV offset.
   */
  kickFov(deltaDegrees: number): void {
    this.fovOffset += deltaDegrees;
  }

  /**
   * Fire a landing dip: the lens drops briefly and eases back over
   * {@link LANDING_DURATION_MS}, plus a little {@link addTrauma} scaled by
   * `strength` so a hard landing also rattles. Re-firing restarts the dip.
   *
   * @param strength Landing intensity, ~0..1 for a normal fall, higher for a
   *                 slam. Scales both the dip depth and the added trauma.
   */
  landingPunch(strength = 1): void {
    this.landingTime = LANDING_DURATION_MS;
    this.landingStrength = strength;
    this.addTrauma(LANDING_TRAUMA * strength);
  }

  /* ------------------------------------------------------------------------ */
  /* Per-frame application                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Fold every active effect into the camera for this frame. Call EXACTLY ONCE
   * per rendered frame, IMMEDIATELY AFTER {@link FollowCamera.update} (which
   * establishes the clean follow pose this method perturbs). Because the follow
   * rig fully overwrites the transform next frame, the offsets added here never
   * accumulate.
   *
   * Order of operations:
   *  1. Advance the noise clock and decay trauma / FOV / landing by `dtMs`.
   *  2. Compute the positional offset (trauma shake + landing dip) and ADD it to
   *     `camera.position`.
   *  3. Compute the small rotational offset and post-multiply it onto
   *     `camera.quaternion` (a local-space roll/pitch/yaw perturbation).
   *  4. Set `camera.fov = baseFov + fovOffset`, rebuilding the projection matrix
   *     ONLY when that value actually moved (skipped while idle).
   *
   * @param dtMs Camera-frame delta in MILLISECONDS. This is presentation time
   *             only — it must NEVER be the simulation / prediction dt.
   */
  apply(dtMs: number): void {
    const dtSec = dtMs / 1000;
    this.time += dtSec;

    // 1. Decay everything by this frame's delta.
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY_PER_S * dtSec);
    }
    if (this.landingTime > 0) {
      this.landingTime = Math.max(0, this.landingTime - dtMs);
    }
    if (this.fovOffset !== 0) {
      this.fovOffset *= Math.pow(0.5, dtMs / FOV_HALF_LIFE_MS);
      if (Math.abs(this.fovOffset) < FOV_MIN_DEG) this.fovOffset = 0;
    }

    // 2. Positional offset = trauma shake (X/Y/Z) + landing dip (−Y).
    this.offset.set(0, 0, 0);

    const magnitude = this.trauma * this.trauma;
    if (magnitude > 0) {
      this.offset.x += magnitude * MAX_SHAKE_POS * this.noise(FREQ_POS_X, PHASE_POS_X);
      this.offset.y += magnitude * MAX_SHAKE_POS * this.noise(FREQ_POS_Y, PHASE_POS_Y);
      this.offset.z += magnitude * MAX_SHAKE_POS_Z * this.noise(FREQ_POS_Z, PHASE_POS_Z);
    }

    if (this.landingTime > 0) {
      // `progress` runs 1 → 0 over the dip. Smoothstep it so the lens eases back
      // to rest rather than snapping, then dip DOWN by that eased fraction.
      const progress = this.landingTime / LANDING_DURATION_MS;
      const eased = progress * progress * (3 - 2 * progress);
      this.offset.y -= MAX_LANDING_DIP * this.landingStrength * eased;
    }

    if (this.offset.x !== 0 || this.offset.y !== 0 || this.offset.z !== 0) {
      this.camera.position.add(this.offset);
    }

    // 3. Rotational offset — pitch/yaw/roll perturbation in the camera's local
    //    frame. Post-multiplying keeps it relative to wherever the follow rig is
    //    already aiming, and next frame's follow.update discards it cleanly.
    if (magnitude > 0) {
      this.euler.set(
        magnitude * MAX_SHAKE_ROT * this.noise(FREQ_ROT_PITCH, PHASE_ROT_PITCH),
        magnitude * MAX_SHAKE_ROT * this.noise(FREQ_ROT_YAW, PHASE_ROT_YAW),
        magnitude * MAX_SHAKE_ROT * this.noise(FREQ_ROT_ROLL, PHASE_ROT_ROLL),
        'XYZ',
      );
      this.quat.setFromEuler(this.euler);
      this.camera.quaternion.multiply(this.quat);
    }

    // 4. FOV. Only rebuild the projection matrix when the value meaningfully
    //    moved — idle frames (offset == 0, fov already at base) cost nothing.
    const targetFov = this.baseFov + this.fovOffset;
    if (Math.abs(targetFov - this.camera.fov) > FOV_APPLY_EPS) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Teardown                                                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * Restore the camera's resting field of view and rebuild its projection
   * matrix, so tearing this layer down leaves the camera exactly as it was
   * handed over. (Position/rotation offsets need no undo — the follow rig
   * overwrites them on its next update.)
   */
  dispose(): void {
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
  }

  /* ------------------------------------------------------------------------ */
  /* Internals                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Smooth, deterministic noise in [-1, 1] for one channel: two summed sines of
   * the internal clock — a primary at `freq` and a weaker secondary at
   * `freq · {@link NOISE_SECONDARY_RATIO}`. The weights sum to 1 so the result
   * never exceeds unit amplitude, and the non-harmonic ratio keeps the pair from
   * ever re-aligning into an obvious single sway.
   *
   * @param freq  Angular frequency of the primary sine, in rad/s.
   * @param phase Fixed phase offset, in radians, that separates this channel.
   */
  private noise(freq: number, phase: number): number {
    return (
      NOISE_PRIMARY_WEIGHT * Math.sin(this.time * freq + phase) +
      NOISE_SECONDARY_WEIGHT *
        Math.sin(this.time * freq * NOISE_SECONDARY_RATIO + phase)
    );
  }
}
