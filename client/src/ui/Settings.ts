/**
 * The Crawling Dark — client preference store (M15 · t15c).
 *
 * `Settings` is the single, typed source of truth for the handful of client-side
 * knobs a player can tweak — post-processing on/off, minimap on/off, mouse
 * sensitivity, and render quality. It is a **pure data module**: it owns no DOM
 * and knows nothing about the systems it configures. The {@link SettingsMenu}
 * (and, later, the real render / input systems) read and write it through the
 * tiny {@link get} / {@link set} / {@link subscribe} surface; wiring those
 * changes into the actual renderer, minimap, and {@link Controls} is a separate
 * integration task and deliberately out of scope here.
 *
 * State is persisted to `localStorage` under a versioned key so preferences
 * survive reloads. Every value read back is **validated and repaired** against
 * the defaults on construction: wrong-typed fields are ignored, an out-of-range
 * `mouseSensitivity` is clamped to a sane band, and an unknown `renderQuality`
 * falls back to the default — a corrupt or stale blob can never crash the store
 * or hand a system a bogus value.
 *
 * All storage access is **offline-safe**: `localStorage` can throw (Safari
 * private mode, disabled storage, quota) or be missing entirely, so every read
 * and write is wrapped in try/catch and the store simply degrades to in-memory
 * only. Nothing here ever throws to its caller.
 *
 * {@link set} writes the whole state back and notifies subscribers only when the
 * value actually changed, so no-op writes are free and listeners don't churn.
 * Call {@link dispose} on teardown to drop all subscribers.
 */

/* -------------------------------------------------------------------------- */
/* Public state contract                                                      */
/* -------------------------------------------------------------------------- */

/** Render-fidelity tier, in ascending order of cost. */
export type RenderQuality = 'low' | 'medium' | 'high';

/** The full, flat set of persisted client preferences. */
export interface SettingsState {
  /** Whether the post-processing stack (bloom, grain, …) is enabled. */
  postProcessing: boolean;
  /** Whether the corner minimap is drawn. */
  minimap: boolean;
  /**
   * When true, the UI suppresses non-essential animations — overlay fades/slides,
   * feed slide-ins — for motion-sensitive players. Essential, information-bearing
   * updates still happen; only the motion flourish around them is dropped.
   */
  reducedMotion: boolean;
  /**
   * Look sensitivity — radians of yaw applied per pixel of pointer movement.
   * Mirrors the current `Controls` `MOUSE_SENSITIVITY`. Always kept within
   * {@link MOUSE_SENSITIVITY_MIN}..{@link MOUSE_SENSITIVITY_MAX}.
   */
  mouseSensitivity: number;
  /** Render-fidelity tier. */
  renderQuality: RenderQuality;
}

/**
 * Change listener signature. Called after a {@link Settings.set} that actually
 * mutated a value, with the changed `key`, its new `value`, and a fresh snapshot
 * of the whole `state` for convenience.
 */
export type SettingsListener = (
  key: keyof SettingsState,
  value: SettingsState[keyof SettingsState],
  state: SettingsState,
) => void;

/* -------------------------------------------------------------------------- */
/* Defaults + validation bounds                                               */
/* -------------------------------------------------------------------------- */

/** Inclusive lower bound for {@link SettingsState.mouseSensitivity}. */
export const MOUSE_SENSITIVITY_MIN = 0.0005;
/** Inclusive upper bound for {@link SettingsState.mouseSensitivity}. */
export const MOUSE_SENSITIVITY_MAX = 0.01;

/** Every valid {@link RenderQuality}, in ascending fidelity order. */
export const RENDER_QUALITIES: readonly RenderQuality[] = ['low', 'medium', 'high'];

/** The out-of-the-box preferences a fresh (or unreadable) store starts from. */
const DEFAULTS: Readonly<SettingsState> = {
  postProcessing: true,
  minimap: true,
  reducedMotion: false,
  // The current Controls `MOUSE_SENSITIVITY`.
  mouseSensitivity: 0.0022,
  renderQuality: 'high',
};

/** Default `localStorage` key; versioned so a future shape change can migrate. */
const DEFAULT_STORAGE_KEY = 'tcd.settings.v1';

/** Clamp `v` into the inclusive `[lo, hi]` band. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Type guard: is `v` one of the {@link RenderQuality} union members? */
function isRenderQuality(v: unknown): v is RenderQuality {
  return v === 'low' || v === 'medium' || v === 'high';
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The typed, `localStorage`-backed preference store. Construct one (optionally
 * with a custom storage key), read with {@link get} / {@link getAll}, write with
 * {@link set}, observe with {@link subscribe}, and {@link dispose} on teardown.
 */
export class Settings {
  private readonly storageKey: string;
  private readonly state: SettingsState;
  private readonly listeners = new Set<SettingsListener>();

  /**
   * @param storageKey `localStorage` key to persist under; defaults to a
   *   versioned app key. On construction the persisted blob is loaded, validated,
   *   and merged over the defaults — bad or missing data falls back cleanly.
   */
  constructor(storageKey: string = DEFAULT_STORAGE_KEY) {
    this.storageKey = storageKey;
    this.state = Settings.load(storageKey);
  }

  /** Read one preference. */
  get<K extends keyof SettingsState>(key: K): SettingsState[K] {
    return this.state[key];
  }

  /**
   * Write one preference. The value is normalized the same way persisted data
   * is (a `mouseSensitivity` outside its band is clamped), so a bad programmatic
   * write can't corrupt the store. Persists the whole state and notifies
   * subscribers **only when the stored value actually changed**.
   */
  set<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void {
    let next: SettingsState[K] = value;
    if (key === 'mouseSensitivity' && typeof value === 'number') {
      next = clamp(value, MOUSE_SENSITIVITY_MIN, MOUSE_SENSITIVITY_MAX) as SettingsState[K];
    }
    if (Object.is(this.state[key], next)) return; // no-op write — nothing to do
    this.state[key] = next;
    this.persist();
    this.notify(key, next as SettingsState[keyof SettingsState]);
  }

  /** A shallow copy of the whole current state (safe for callers to keep). */
  getAll(): SettingsState {
    return { ...this.state };
  }

  /**
   * Subscribe to changes. `fn` fires after any {@link set} that actually mutated
   * a value, with `(key, value, state)`. Returns an idempotent unsubscribe fn.
   */
  subscribe(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Drop all subscribers. The in-memory state (and storage) are left intact. */
  dispose(): void {
    this.listeners.clear();
  }

  /* ---- Internals -------------------------------------------------------- */

  /**
   * Load + validate the persisted blob, merged over {@link DEFAULTS}. Any
   * failure along the way (storage unavailable, absent, non-JSON, wrong shape)
   * simply yields the defaults — this never throws.
   */
  private static load(storageKey: string): SettingsState {
    const state: SettingsState = { ...DEFAULTS };

    let raw: string | null = null;
    try {
      raw = localStorage.getItem(storageKey);
    } catch {
      return state; // storage unavailable — in-memory defaults only
    }
    if (raw === null) return state; // nothing persisted yet

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return state; // corrupt JSON — ignore and repair to defaults
    }
    return Settings.merge(state, parsed);
  }

  /**
   * Overlay a parsed, untrusted blob onto `base`, taking each field only when it
   * is present and well-typed: booleans as-is, `mouseSensitivity` clamped to its
   * band, and `renderQuality` validated against the union. Unknown or malformed
   * fields are left at their default. Mutates and returns `base`.
   */
  private static merge(base: SettingsState, parsed: unknown): SettingsState {
    if (typeof parsed !== 'object' || parsed === null) return base;
    const src = parsed as Record<string, unknown>;

    if (typeof src.postProcessing === 'boolean') base.postProcessing = src.postProcessing;
    if (typeof src.minimap === 'boolean') base.minimap = src.minimap;
    if (typeof src.reducedMotion === 'boolean') base.reducedMotion = src.reducedMotion;

    const ms = src.mouseSensitivity;
    if (typeof ms === 'number' && Number.isFinite(ms)) {
      base.mouseSensitivity = clamp(ms, MOUSE_SENSITIVITY_MIN, MOUSE_SENSITIVITY_MAX);
    }

    if (isRenderQuality(src.renderQuality)) base.renderQuality = src.renderQuality;

    return base;
  }

  /** Serialize the whole state to storage. Offline-safe — swallows failures. */
  private persist(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.state));
    } catch {
      // Storage unavailable / full (private mode, quota) — stay in-memory. Non-fatal.
    }
  }

  /** Fan a change out to every subscriber with a fresh state snapshot. */
  private notify(key: keyof SettingsState, value: SettingsState[keyof SettingsState]): void {
    const snapshot = this.getAll();
    for (const fn of this.listeners) fn(key, value, snapshot);
  }
}
