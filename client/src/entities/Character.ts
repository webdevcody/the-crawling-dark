/**
 * The Crawling Dark — articulated character rigs (M6 · t6c).
 *
 * Replaces the placeholder team-colored boxes with jointed humanoid bodies that
 * ANIMATE to match each entity's movement/combat `state`, so the world reads at
 * a glance: humans stride and swing a bat, zombies shamble hunched with arms
 * out and lunge with a claw, and both share the combat tells (stun, downed).
 *
 * ── Why procedural primitives (and not a GLTF) ──────────────────────────────
 * This client ships with no bundled `.glb`/`.gltf` assets and cannot rely on a
 * runtime network fetch, so a real rigged model would silently render nothing.
 * Instead each {@link Character} builds a small skeleton from Three.js
 * primitives (a torso + head + two arms + two legs, each limb on a pivot at its
 * shoulder/hip) and drives the joints in code every frame.
 *
 * ── The {@link CharacterModel} seam (the point of this file) ─────────────────
 * All of that lives behind a deliberately tiny interface — `root`, `setTeam`,
 * `update`, `dispose` — so `main.ts` never learns HOW a body is drawn. When real
 * rigged assets become available, a drop-in `GltfCharacter implements
 * CharacterModel` can:
 *
 *   1. load a shared `THREE.Group` via
 *      `three/examples/jsm/loaders/GLTFLoader.js` (loaded once, cloned per body),
 *   2. drive a per-instance `THREE.AnimationMixer` whose clips are NAMED BY
 *      STATE (`idle`/`walk`/`run`/`crawl`/`jump`/`swing`(+`claw`)/`stun`/`down`),
 *      cross-fading to the clip for the `state` passed to {@link update} and
 *      advancing the mixer by `dtMs / 1000` seconds,
 *
 * and swap in behind this same interface WITHOUT touching `main.ts`. That
 * swappability is why the seam exists; the loader is intentionally NOT imported
 * here (it would bloat the bundle for a code path we can't exercise offline) —
 * it is documented only.
 *
 * ── Per-frame budget ────────────────────────────────────────────────────────
 * The rig is built ONCE in the constructor. {@link update} only assigns numbers
 * onto existing joints and copies into cached scratch colors — it never creates
 * geometry, materials, or vectors — so a crowd of bodies stays allocation-free.
 * Every pose value is ASSIGNED (never accumulated) from a clean base each frame,
 * so a state ending automatically restores the body on the next tick.
 *
 * Yaw convention (matches the sim + follow camera): forward(yaw) =
 * (-sin yaw, 0, -cos yaw), so yaw 0 faces -Z. A downward-hanging limb (-Y)
 * rotated about +X by a POSITIVE angle swings its tip toward -Z (forward); a
 * body part above its pivot leans forward for a NEGATIVE angle. The build below
 * relies on those two facts throughout.
 */

import * as THREE from 'three';
import {
  PLAYER_HEIGHT,
  CRAWL_HEIGHT,
  type EntityKind,
  type EntityState,
} from '@crawling-dark/shared';

/* -------------------------------------------------------------------------- */
/* The seam                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The rendering seam every character implementation honors. `main.ts` owns a
 * `Map<number, CharacterModel>`, adds {@link root} to the scene on first sight,
 * positions `root` at the entity's feet, recolors on a team flip via
 * {@link setTeam}, drives the pose via {@link update}, and {@link dispose}s on
 * departure. A GLTF/AnimationMixer body can implement this identically.
 */
export interface CharacterModel {
  /**
   * The body's scene node. Its ORIGIN sits at the entity's feet, so the caller
   * can place a body simply by copying the entity's `{x, y, z}` (feet height)
   * onto `root.position`. Facing (yaw) is applied inside {@link update}.
   */
  readonly root: THREE.Object3D;

  /**
   * Paint the body for its team and rebuild its silhouette (humans upright,
   * zombies hunched). Called on spawn and again whenever an entity's `kind`
   * flips mid-round (a human turning into a zombie keeps its id), which is what
   * makes an infection visibly recolor the body.
   */
  setTeam(kind: EntityKind, isLocal: boolean): void;

  /**
   * Pose the body for one frame from its movement/combat `state` and facing
   * `yaw`. `nowMs` (a {@link performance.now} reading) drives time-based cadence
   * so animation speed is independent of frame rate; `dtMs` is the frame delta
   * (reserved for a future `AnimationMixer.update(dtMs / 1000)` — the procedural
   * rig is purely `nowMs`-driven and ignores it).
   */
  update(state: EntityState, yaw: number, nowMs: number, dtMs: number): void;

  /** Release GPU resources uniquely owned by this body (never shared assets). */
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* Team colors (ported verbatim from the old box renderer)                     */
/* -------------------------------------------------------------------------- */

/** Highlight color for the local player (human) so you can tell which body is you. */
const LOCAL_COLOR = new THREE.Color(0x53ffa8);

/**
 * The LOCAL player's zombie tint — a toxic, self-lit green. Combined with the
 * strong emissive glow every local body carries, it keeps "you" unmistakable
 * even after turning, while still visibly reading as the zombie team.
 */
const LOCAL_ZOMBIE_COLOR = new THREE.Color(0x9dff2f);

/** Electric-yellow tint layered onto a body's emissive while it is stunned. */
const STUN_TINT = new THREE.Color(0xffe14a);

/** How far a downed body's color is dimmed toward black in the death-cam. */
const DOWN_DIM = 0.32;

/** Deterministic, well-spread color from an entity id (golden-ratio hue). */
function colorForId(id: number): THREE.Color {
  const hue = (id * 0.61803398875) % 1;
  return new THREE.Color().setHSL(hue, 0.6, 0.55);
}

/**
 * Desaturated, sickly green/olive for a zombie body. A slight per-id hue jitter
 * keeps a horde from reading as one flat blob while staying firmly in the
 * "infected" palette so zombies never look like the bright human colors.
 */
function zombieColorForId(id: number): THREE.Color {
  const hue = 0.26 + ((id * 0.61803398875) % 1) * 0.06; // narrow green/olive band
  return new THREE.Color().setHSL(hue, 0.32, 0.3);
}

/* -------------------------------------------------------------------------- */
/* Rig proportions + shared geometry                                           */
/* -------------------------------------------------------------------------- */

/*
 * Meters, measured from the feet (y = 0, the `root` origin). Tuned so the
 * standing head reaches ~PLAYER_HEIGHT (1.8 m) and the shoulder-to-shoulder
 * span ≈ the collision diameter (2 × PLAYER_RADIUS = 0.8 m), so a body reads as
 * exactly the thing it collides as.
 */
const HIP_Y = 0.92; // hip-joint height; also the base of the torso and the leg pivot
const TORSO_H = 0.62; // torso box height (hips → shoulders)
const TORSO_W = 0.46; // torso width  (x)
const TORSO_D = 0.28; // torso depth  (z)
const HEAD_R = 0.16; // head radius
const NECK = 0.06; // gap between torso top and head center
const ARM_LEN = 0.62; // shoulder → hand
const ARM_W = 0.14; // arm thickness
const LEG_LEN = HIP_Y; // hip → floor
const LEG_W = 0.17; // leg thickness
const SHOULDER_X = TORSO_W / 2 + ARM_W / 2; // arm pivot offset from center
const LEG_X = 0.13; // leg pivot offset from center

/**
 * One shared geometry set for EVERY body (like the old shared `PLAYER_GEOMETRY`
 * box). Because these are shared, {@link Character.dispose} must never dispose
 * them — only the per-instance material it owns.
 */
const GEO_TORSO = new THREE.BoxGeometry(TORSO_W, TORSO_H, TORSO_D);
const GEO_HEAD = new THREE.SphereGeometry(HEAD_R, 16, 12);
const GEO_ARM = new THREE.BoxGeometry(ARM_W, ARM_LEN, ARM_W);
const GEO_LEG = new THREE.BoxGeometry(LEG_W, LEG_LEN, LEG_W);

/* -------------------------------------------------------------------------- */
/* Character                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A procedurally-rigged humanoid: a torso + head + two arms + two legs jointed
 * so the limbs swing, driven every frame by an entity's `state`. Implements the
 * {@link CharacterModel} seam so it can later be swapped for a GLTF-backed body.
 *
 * Node hierarchy (each level is a swing/lean pivot the animation drives):
 *
 *   root ── world placement (position = feet; rotation.y = facing yaw + wobble)
 *    └ frame ── body offset: breathing bob, stun shake, downed/crawl sink
 *       └ hips (@ y = HIP_Y) ── whole-body pitch (crawl/down) + stun roll
 *          ├ torso ── upper-body lean (run/attack); carries head + both arms
 *          │   ├ torsoMesh, head
 *          │   └ armL, armR (pivots at the shoulders)
 *          └ legL, legR (pivots at the hips)
 */
export class Character implements CharacterModel {
  /** Scene node; origin at the feet. Positioned + added to the scene by the caller. */
  readonly root: THREE.Group;

  /** Current team, exposed so the caller can detect a `kind` flip and recolor. */
  kind: EntityKind = 'human';

  /* -- animated joints (built once, only re-posed per frame) --------------- */
  private readonly frame: THREE.Group;
  private readonly hips: THREE.Group;
  private readonly torso: THREE.Group;
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;

  /** The one material every part shares; owned here and disposed in {@link dispose}. */
  private readonly material: THREE.MeshStandardMaterial;

  /** Cached "clean team" colors the per-frame state overlay always starts from. */
  private readonly baseColor = new THREE.Color();
  private readonly baseEmissive = new THREE.Color();

  /**
   * Team-dependent NEUTRAL pose the animation layers on top of: humans stand
   * with arms down and torso vertical; zombies hunch with arms reaching forward.
   * Set by {@link setTeam}.
   */
  private armBaseX = 0;
  private torsoBaseX = 0;

  /** The entity id, used only for the deterministic per-id team hue. */
  private readonly id: number;

  /**
   * Build the skeleton once. `setTeam` must be called before the first
   * {@link update} to paint the body and choose its human/zombie silhouette.
   */
  constructor(id: number) {
    this.id = id;

    this.material = new THREE.MeshStandardMaterial({
      roughness: 0.5,
      metalness: 0.1,
    });

    // A tiny factory so every part shares the one material and casts shadows.
    const part = (geo: THREE.BufferGeometry): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.castShadow = true;
      return mesh;
    };

    this.root = new THREE.Group();
    this.frame = new THREE.Group();
    this.hips = new THREE.Group();
    this.torso = new THREE.Group();
    this.armL = new THREE.Group();
    this.armR = new THREE.Group();
    this.legL = new THREE.Group();
    this.legR = new THREE.Group();

    // hips sit at HIP_Y; torso + legs pivot from there.
    this.hips.position.y = HIP_Y;

    // Torso box (its base at the hips) + head above the neck.
    const torsoMesh = part(GEO_TORSO);
    torsoMesh.position.y = TORSO_H / 2;
    const head = part(GEO_HEAD);
    head.position.y = TORSO_H + NECK + HEAD_R;

    // Arms pivot at the shoulders (top of the torso) and hang straight down.
    this.armL.position.set(-SHOULDER_X, TORSO_H, 0);
    this.armR.position.set(SHOULDER_X, TORSO_H, 0);
    const armMeshL = part(GEO_ARM);
    const armMeshR = part(GEO_ARM);
    armMeshL.position.y = -ARM_LEN / 2;
    armMeshR.position.y = -ARM_LEN / 2;
    this.armL.add(armMeshL);
    this.armR.add(armMeshR);

    // Legs pivot at the hips and hang straight down to the floor.
    this.legL.position.set(-LEG_X, 0, 0);
    this.legR.position.set(LEG_X, 0, 0);
    const legMeshL = part(GEO_LEG);
    const legMeshR = part(GEO_LEG);
    legMeshL.position.y = -LEG_LEN / 2;
    legMeshR.position.y = -LEG_LEN / 2;
    this.legL.add(legMeshL);
    this.legR.add(legMeshR);

    // Assemble: torso carries head + arms; hips carry torso + legs.
    this.torso.add(torsoMesh, head, this.armL, this.armR);
    this.hips.add(this.torso, this.legL, this.legR);
    this.frame.add(this.hips);
    this.root.add(this.frame);
  }

  /**
   * Paint the body for its team, cache the resulting base colors, and choose the
   * human/zombie silhouette. The LOCAL player is kept self-lit (a strong
   * emissive glow) so you can always pick yourself out of a crowd; its base hue
   * still tracks your team (spring green as a human → toxic green as a zombie).
   */
  setTeam(kind: EntityKind, isLocal: boolean): void {
    this.kind = kind;

    if (isLocal) {
      this.baseColor.copy(kind === 'zombie' ? LOCAL_ZOMBIE_COLOR : LOCAL_COLOR);
      // Strong self-glow marks "you" regardless of team.
      this.baseEmissive.copy(this.baseColor).multiplyScalar(0.3);
    } else if (kind === 'zombie') {
      this.baseColor.copy(zombieColorForId(this.id));
      // Faint sickly glow so zombies read as "infected" even in shadow.
      this.baseEmissive.setHex(0x142808);
    } else {
      this.baseColor.copy(colorForId(this.id));
      this.baseEmissive.setHex(0x000000);
    }

    this.material.color.copy(this.baseColor);
    this.material.emissive.copy(this.baseEmissive);

    // Silhouette: humans stand tall with arms down; zombies hunch with arms out
    // in front. These set the NEUTRAL pose the per-frame animation adds onto.
    if (kind === 'zombie') {
      this.armBaseX = 1.3; // arms reaching forward (+X rotation swings the tip to -Z)
      this.torsoBaseX = -0.32; // hunched forward (top toward -Z)
    } else {
      this.armBaseX = 0;
      this.torsoBaseX = 0;
    }
  }

  /**
   * Pose the rig for one frame from its `state`. Every joint angle and the
   * material tint are ASSIGNED from a clean team base, so no state leaks into
   * the next frame. `nowMs` drives all cadence (matching how the old box's stun
   * shake was time-based); `dtMs` is unused by this procedural rig and is kept
   * only to satisfy the AnimationMixer-ready {@link CharacterModel} seam.
   */
  update(state: EntityState, yaw: number, nowMs: number, dtMs: number): void {
    void dtMs; // reserved for a future AnimationMixer.update(dtMs / 1000)

    const t = nowMs * 0.001; // seconds, for time-based cadence

    // Restore the clean team look; state overlays tint on top of it.
    this.material.color.copy(this.baseColor);
    this.material.emissive.copy(this.baseEmissive);

    // Pose scratch, defaulted to the team's neutral standing silhouette.
    let hipPitch = 0; // whole-body forward pitch (crawl/down), about the hips
    let hipRoll = 0; // whole-body sideways wobble (stun)
    let torsoPitch = this.torsoBaseX; // upper-body lean (run/attack)
    let bobY = 0; // vertical body offset (breathing / gait)
    let sink = 0; // extra lowering for prone poses (crawl/down)
    let shakeX = 0; // lateral jitter (stun)
    let shakeZ = 0;
    let yawWobble = 0; // facing jitter (stun)
    let legLRot = 0;
    let legRRot = 0;
    let armLRot = this.armBaseX;
    let armRRot = this.armBaseX;

    switch (state) {
      case 'idle': {
        // Subtle breathing bob + a faint arm sway.
        const b = Math.sin(t * 1.6);
        bobY = b * 0.02;
        armLRot = this.armBaseX + b * 0.05;
        armRRot = this.armBaseX - b * 0.05;
        break;
      }
      case 'walk': {
        // Alternating leg/arm swing at a moderate cadence, with a light gait bob.
        const s = Math.sin(t * 7);
        legLRot = s * 0.5;
        legRRot = -s * 0.5;
        armLRot = this.armBaseX - s * 0.45; // arms counter-swing the legs
        armRRot = this.armBaseX + s * 0.45;
        bobY = Math.abs(s) * 0.03 - 0.015;
        break;
      }
      case 'run': {
        // Faster, longer stride + a forward lean and a bigger bounce.
        const s = Math.sin(t * 11);
        legLRot = s * 0.85;
        legRRot = -s * 0.85;
        armLRot = this.armBaseX - s * 0.8;
        armRRot = this.armBaseX + s * 0.8;
        torsoPitch += -0.28; // lean into the run
        bobY = Math.abs(s) * 0.05;
        break;
      }
      case 'crawl': {
        // Prone, low profile near CRAWL_HEIGHT: pitch the body forward at the
        // hips, sink it, and stroke the arms/legs in a slow crawl.
        const s = Math.sin(t * 4.5);
        hipPitch = -1.15;
        torsoPitch += 0.35; // lift the head so a face still reads
        sink = -(PLAYER_HEIGHT - CRAWL_HEIGHT) * 0.17; // ease toward the low profile
        armLRot = 1.3 + s * 0.4; // reach forward, alternating
        armRRot = 1.3 - s * 0.4;
        legLRot = -0.2 - s * 0.3; // legs trail and push
        legRRot = -0.2 + s * 0.3;
        break;
      }
      case 'jump': {
        // Tuck: knees up toward the chest, arms thrown up. `root.y` (feet
        // height) already lifts the whole body while airborne.
        legLRot = 0.95;
        legRRot = 0.9;
        armLRot = 1.5;
        armRRot = 1.5;
        torsoPitch += -0.1;
        break;
      }
      case 'attack': {
        if (this.kind === 'zombie') {
          // Forward CLAW lunge: arms rake out ahead (alternating), body dives in.
          const s = 0.5 - 0.5 * Math.cos(nowMs * 0.022);
          armLRot = 1.3 + s * 0.6;
          armRRot = 1.3 + (1 - s) * 0.6; // opposite phase → a raking claw
          torsoPitch += -0.15 - s * 0.3;
          legLRot = 0.2; // planted lunge stance
          legRRot = -0.2;
          this.material.emissive.copy(this.baseColor).multiplyScalar(0.3 + s * 0.25);
        } else {
          // Human BAT swing: the right arm chops overhead → down-front, body lunges.
          const s = 0.5 - 0.5 * Math.cos(nowMs * 0.02);
          armRRot = 2.6 - s * 2.4; // raised-back (2.6) → down-front (0.2)
          armLRot = 0.4 + s * 0.3;
          torsoPitch += -0.15 - s * 0.25;
          legLRot = 0.25;
          legRRot = -0.15;
          this.material.emissive.copy(this.baseColor).multiplyScalar(0.35 + s * 0.2);
        }
        break;
      }
      case 'stun': {
        // Rattled: a time-driven shake + wobble, tinted electric yellow. Phase
        // matches the old box's stun shake (`nowMs * 0.03`).
        const s = nowMs * 0.03;
        shakeX = Math.sin(s) * 0.06;
        shakeZ = Math.cos(s * 1.3) * 0.06;
        yawWobble = Math.sin(s * 0.7) * 0.25;
        hipRoll = Math.sin(s * 1.1) * 0.14;
        armLRot = this.armBaseX + Math.sin(s * 1.7) * 0.3;
        armRRot = this.armBaseX - Math.sin(s * 1.9) * 0.3;
        this.material.emissive.copy(this.baseEmissive).lerp(STUN_TINT, 0.75);
        break;
      }
      case 'down': {
        // Death-cam: collapse flat on the ground, dimmed and unlit.
        hipPitch = -1.45; // fold the whole body horizontal, face-down
        sink = -(HIP_Y - 0.14); // rest the flat body just above the ground
        armLRot = -0.2; // arms splayed
        armRRot = 0.2;
        legLRot = 0.1;
        legRRot = -0.1;
        this.material.color.copy(this.baseColor).multiplyScalar(DOWN_DIM);
        this.material.emissive.setRGB(0, 0, 0);
        break;
      }
      default:
        break;
    }

    // Commit the pose (all assigned; nothing accumulates frame-to-frame).
    this.root.rotation.y = yaw + yawWobble;
    this.frame.position.set(shakeX, bobY + sink, shakeZ);
    this.hips.rotation.set(hipPitch, 0, hipRoll);
    this.torso.rotation.x = torsoPitch;
    this.armL.rotation.x = armLRot;
    this.armR.rotation.x = armRRot;
    this.legL.rotation.x = legLRot;
    this.legR.rotation.x = legRRot;
  }

  /**
   * Release GPU resources. Only the per-instance MATERIAL is disposed — the
   * body geometries are shared by every character and must never be disposed
   * (exactly the invariant the old shared `PLAYER_GEOMETRY` carried). The caller
   * is responsible for removing {@link root} from the scene.
   */
  dispose(): void {
    this.material.dispose();
  }
}
