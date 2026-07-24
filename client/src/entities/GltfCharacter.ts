/**
 * The Crawling Dark — GLTF-backed character bodies (M13 · t13a).
 *
 * The drop-in the {@link CharacterModel} seam in `entities/Character.ts` was
 * designed for: a rigged GLTF model that replaces the procedural box-rig WITHOUT
 * any change to `main.ts` beyond the single renderer switch. It honors the exact
 * same tiny interface — `root` / `kind` / `setTeam` / `update` / `dispose` — so
 * the reconciliation loop never learns how a body is drawn.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 *  • Load-once, clone-per-body: the `.glb` for a URL is fetched a SINGLE time
 *    (module-level {@link loadAsset} cache) and every body is a lightweight
 *    `SkeletonUtils.clone` of that shared scene (shared geometry; per-instance
 *    materials so a team tint can't bleed across bodies).
 *  • A per-instance {@link THREE.AnimationMixer} plays clips NAMED BY STATE —
 *    `idle` / `walk` / `run` / `crawl` / `jump` / `swing` / `claw` / `stun` /
 *    `down` — cross-fading to the clip for the `state` passed to {@link update}
 *    and advancing by `dtMs / 1000`. (`attack` maps to `swing` for a human and
 *    `claw` for a zombie — the two faces of the one combat state.)
 *  • Team flip: recolors the per-instance materials, and — if a distinct
 *    per-team model URL is configured — swaps the model, exactly mirroring the
 *    procedural rig's recolor/reshape on infection.
 *
 * ── Offline-safe fallback ───────────────────────────────────────────────────
 * Construction is synchronous but asset loading is async, and the sandbox may
 * have no asset at all. So every body starts as — and permanently stays, if the
 * fetch misses — a procedural {@link Character} mounted under `root`. When (if)
 * the shared asset resolves, the real model swaps in and the stand-in is
 * dropped. The heavy `GLTFLoader` / `SkeletonUtils` modules are imported
 * DYNAMICALLY inside {@link loadAsset}, so a build left on the procedural
 * renderer never pulls them into the main bundle (the concern documented in
 * `Character.ts`).
 */

import * as THREE from 'three';
import type { EntityKind, EntityState } from '@crawling-dark/shared';
import { Character, type CharacterModel } from './Character';

/* -------------------------------------------------------------------------- */
/* Shared, load-once asset cache                                               */
/* -------------------------------------------------------------------------- */

/** A parsed model: the shared source scene + its clips indexed by lower-cased name. */
interface LoadedAsset {
  scene: THREE.Object3D;
  clips: Map<string, THREE.AnimationClip>;
}

/** One in-flight/resolved load per URL (`null` = load failed → use fallback). */
const assetCache = new Map<string, Promise<LoadedAsset | null>>();

/** `SkeletonUtils.clone`, captured on first successful dynamic import. */
let skeletonClone: ((source: THREE.Object3D) => THREE.Object3D) | null = null;

/**
 * Fetch + parse a `.glb` at most once per URL. The `GLTFLoader` / `SkeletonUtils`
 * addons are imported here (lazily) so they only enter the bundle graph when the
 * GLTF renderer is actually used. Any failure (offline, 404, decode error)
 * resolves to `null` so callers transparently keep their procedural stand-in.
 */
function loadAsset(url: string): Promise<LoadedAsset | null> {
  let pending = assetCache.get(url);
  if (pending === undefined) {
    pending = (async () => {
      try {
        const [{ GLTFLoader }, { clone }] = await Promise.all([
          import('three/examples/jsm/loaders/GLTFLoader.js'),
          import('three/examples/jsm/utils/SkeletonUtils.js'),
        ]);
        skeletonClone = clone;
        const gltf = await new GLTFLoader().loadAsync(url);
        const clips = new Map<string, THREE.AnimationClip>();
        for (const c of gltf.animations) clips.set(c.name.toLowerCase(), c);
        return { scene: gltf.scene, clips };
      } catch {
        return null; // offline-safe: fall back to the procedural rig
      }
    })();
    assetCache.set(url, pending);
  }
  return pending;
}

/* -------------------------------------------------------------------------- */
/* Team colors (mirrors entities/Character.ts so GLTF + procedural bodies match) */
/* -------------------------------------------------------------------------- */

const LOCAL_COLOR = new THREE.Color(0x53ffa8);
const LOCAL_ZOMBIE_COLOR = new THREE.Color(0x9dff2f);

function colorForId(id: number): THREE.Color {
  const hue = (id * 0.61803398875) % 1;
  return new THREE.Color().setHSL(hue, 0.6, 0.55);
}
function zombieColorForId(id: number): THREE.Color {
  const hue = 0.26 + ((id * 0.61803398875) % 1) * 0.06;
  return new THREE.Color().setHSL(hue, 0.32, 0.3);
}

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

/** Model URLs. `zombie` defaults to `human`; giving a distinct one model-swaps. */
export interface GltfCharacterAssets {
  human: string;
  zombie?: string;
}

/** Cross-fade duration between two state clips, in seconds. */
const CROSSFADE_S = 0.18;

/* -------------------------------------------------------------------------- */
/* GltfCharacter                                                               */
/* -------------------------------------------------------------------------- */

export class GltfCharacter implements CharacterModel {
  /** Scene node; origin at the feet (identical placement contract to {@link Character}). */
  readonly root = new THREE.Group();

  /** Current team, read by the caller to detect a mid-round `kind` flip. */
  kind: EntityKind = 'human';

  private readonly id: number;
  private readonly assets: GltfCharacterAssets;
  private isLocal = false;
  private disposed = false;

  /** Procedural stand-in shown until (and if never, instead of) a real model loads. */
  private readonly fallback: Character;
  private fallbackMounted = true;

  /* -- GLTF-active state (all null while the stand-in is up) --------------- */
  private model: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private clips: Map<string, THREE.AnimationClip> | null = null;
  private current: THREE.AnimationAction | null = null;
  private currentClip: string | null = null;
  /** Per-instance materials this body owns and must dispose (never shared ones). */
  private readonly ownedMaterials = new Set<THREE.Material>();

  private activeUrl: string | null = null;
  /** Bumped on every (re)load + on dispose to cancel stale async mounts. */
  private loadToken = 0;

  /* -- last-seen pose, so a late-arriving model initializes correctly ------ */
  private lastState: EntityState = 'idle';
  private lastYaw = 0;

  constructor(id: number, assets: GltfCharacterAssets) {
    this.id = id;
    this.assets = assets;
    this.fallback = new Character(id);
    this.root.add(this.fallback.root);
  }

  /** The model URL for a team (distinct `zombie` URL → model-swap on infection). */
  private urlForKind(kind: EntityKind): string {
    return kind === 'zombie' && this.assets.zombie !== undefined
      ? this.assets.zombie
      : this.assets.human;
  }

  setTeam(kind: EntityKind, isLocal: boolean): void {
    this.kind = kind;
    this.isLocal = isLocal;
    // Keep the stand-in correct too (it drives the body until/unless a model loads).
    this.fallback.setTeam(kind, isLocal);
    // Recolor an existing model immediately (a team flip shows at once); a
    // distinct per-team model then swaps in asynchronously via ensureModel().
    if (this.model !== null) this.applyTeamTint();
    this.ensureModel();
  }

  /** Kick off the (first or model-swapped) load for the current team, if needed. */
  private ensureModel(): void {
    const url = this.urlForKind(this.kind);
    if (this.activeUrl === url && this.model !== null) return; // already correct
    const token = ++this.loadToken;
    void loadAsset(url).then((asset) => {
      if (this.disposed || token !== this.loadToken) return;
      if (asset === null || skeletonClone === null) return; // stay procedural
      this.mount(url, asset);
    });
  }

  /** Swap the shared asset in: clone it, own per-instance materials, wire the mixer. */
  private mount(url: string, asset: LoadedAsset): void {
    this.unmountModel();

    const clone = skeletonClone!(asset.scene);
    clone.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => this.own(m.clone()))
        : this.own((mesh.material as THREE.Material).clone());
    });

    this.model = clone;
    this.clips = asset.clips;
    this.activeUrl = url;
    this.mixer = new THREE.AnimationMixer(clone);
    this.current = null;
    this.currentClip = null;
    this.root.add(clone);
    this.applyTeamTint();

    // Real body is up: drop the procedural stand-in.
    if (this.fallbackMounted) {
      this.root.remove(this.fallback.root);
      this.fallbackMounted = false;
    }

    // Snap straight to the live state's clip (no fade on first frame) + facing.
    this.playClip(this.clipNameFor(this.lastState), true);
    this.root.rotation.y = this.lastYaw;
  }

  update(state: EntityState, yaw: number, nowMs: number, dtMs: number): void {
    this.lastState = state;
    this.lastYaw = yaw;

    if (this.mixer !== null && this.model !== null) {
      this.root.rotation.y = yaw; // GLTF body: our container carries facing
      this.playClip(this.clipNameFor(state));
      this.mixer.update(dtMs / 1000);
    } else {
      // Procedural stand-in applies its own yaw on its own root; keep ours flat.
      this.root.rotation.y = 0;
      this.fallback.update(state, yaw, nowMs, dtMs);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.loadToken++; // cancel any in-flight mount
    this.unmountModel();
    this.fallback.dispose();
    // Removing `root` from the scene is the caller's responsibility (as before).
  }

  /* ---- internals -------------------------------------------------------- */

  /** The clip name for a state, resolving `attack` to the team's attack clip. */
  private clipNameFor(state: EntityState): string {
    if (state === 'attack') return this.kind === 'zombie' ? 'claw' : 'swing';
    return state;
  }

  /** Cross-fade to `name`'s clip (or snap, on first mount); tolerant of gaps. */
  private playClip(name: string, immediate = false): void {
    if (name === this.currentClip || this.mixer === null) return;
    const clip = this.resolveClip(name);
    if (clip === null) return;

    const next = this.mixer.clipAction(clip);
    next.enabled = true;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.reset();
    next.play();

    if (this.current !== null && this.current !== next) {
      if (immediate) this.current.stop();
      else this.current.crossFadeTo(next, CROSSFADE_S, false);
    }
    this.current = next;
    this.currentClip = name;
  }

  /** Look a clip up by state name; fall back to `idle`, then any clip. */
  private resolveClip(name: string): THREE.AnimationClip | null {
    const clips = this.clips;
    if (clips === null) return null;
    return clips.get(name) ?? clips.get('idle') ?? clips.values().next().value ?? null;
  }

  private own(m: THREE.Material): THREE.Material {
    this.ownedMaterials.add(m);
    return m;
  }

  /** Team hue for this body (mirrors {@link Character.setTeam}'s palette). */
  private teamColor(): THREE.Color {
    if (this.isLocal) return (this.kind === 'zombie' ? LOCAL_ZOMBIE_COLOR : LOCAL_COLOR).clone();
    return this.kind === 'zombie' ? zombieColorForId(this.id) : colorForId(this.id);
  }

  /** Emissive glow: a strong self-glow for the local body, faint for zombies. */
  private teamEmissive(color: THREE.Color): THREE.Color {
    if (this.isLocal) return color.clone().multiplyScalar(0.3);
    if (this.kind === 'zombie') return new THREE.Color(0x142808);
    return new THREE.Color(0x000000);
  }

  /** Paint every owned material for the current team (color + emissive). */
  private applyTeamTint(): void {
    const color = this.teamColor();
    const emissive = this.teamEmissive(color);
    for (const m of this.ownedMaterials) {
      const std = m as THREE.MeshStandardMaterial;
      if (std.color !== undefined) std.color.copy(color);
      if (std.emissive !== undefined) std.emissive.copy(emissive);
    }
  }

  /** Tear down the live model (mixer, node, per-instance materials); shared assets untouched. */
  private unmountModel(): void {
    if (this.mixer !== null) {
      this.mixer.stopAllAction();
      if (this.model !== null) this.mixer.uncacheRoot(this.model);
      this.mixer = null;
    }
    if (this.model !== null) {
      this.root.remove(this.model);
      this.model = null;
    }
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.clear();
    this.clips = null;
    this.current = null;
    this.currentClip = null;
    this.activeUrl = null;
  }
}
