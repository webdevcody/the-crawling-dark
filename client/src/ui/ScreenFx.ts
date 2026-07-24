/**
 * The Crawling Dark — screen-space feedback overlay (M14 · t14d).
 *
 * `ScreenFx` is the self-contained, full-viewport DOM overlay that gives the
 * LOCAL player fast, visceral, screen-space feedback for the three things that
 * matter most in a survival-horror crawl: getting hit, getting turned, and
 * something lethal creeping up on you. It owns a tiny stack of fixed,
 * pointer-events-through layers it appends to a container passed in the
 * constructor (the same `#app` div the renderer + HUD live in):
 *
 *   - a **damage layer** — a red inset radial vignette that flashes on a hit and
 *     can be biased toward the screen edge the blow came from;
 *   - an **infection layer** — a sickly-green full-screen flash + vignette that
 *     blooms hard and lingers when the local player turns;
 *   - a **danger layer** — a persistent red edge vignette whose strength tracks
 *     proximity to the nearest zombie and gently "breathes" via a sine pulse.
 *
 * Every layer is built ONCE in the constructor. Per frame, {@link update} only
 * writes `opacity` (and, for the danger pulse, nothing more): the transient
 * flashes decay over their own timelines and the danger layer eases toward its
 * target. Directional bias rebuilds the damage layer's gradient string, but only
 * on the {@link damageFrom} event — never per frame — so a running overlay does
 * no layout work and effectively no allocation beyond the numeric opacity string.
 *
 * Like the HUD, it deliberately depends only on the DOM (no Three.js), mirroring
 * the render-agnostic split the rest of the client's UI uses. The whole overlay
 * is `pointer-events: none`, so it sits above the WebGL canvas without ever
 * stealing clicks from the interactive HUD (e.g. the audio panel).
 */

/* -------------------------------------------------------------------------- */
/* Palette + tuning                                                           */
/* -------------------------------------------------------------------------- */

/** Deep arterial red for the damage flash + persistent danger vignette. */
const RED = '150, 18, 18';
/** Sickly, radioactive green for the infection bloom (~`#76ff5a`). */
const GREEN = '118, 255, 90';
/** Darker green for the infection vignette's saturated edge. */
const GREEN_EDGE = '70, 180, 50';

/** How long the quick damage flash takes to fade fully (ms). */
const DAMAGE_MS = 450;
/** How long the infection bloom eases out (ms) — the longest, most lingering. */
const INFECT_MS = 1200;

/** Peak opacity of the damage flash at the instant of the hit. */
const DAMAGE_MAX = 0.55;
/** Peak opacity of the infection bloom — the strongest of the three. */
const INFECT_MAX = 0.85;
/** Peak opacity the danger vignette reaches at full (intensity 1) proximity. */
const DANGER_MAX = 0.6;

/** Time constant (ms) the danger vignette eases toward its target with. */
const DANGER_TAU = 220;
/** Danger "breathing" pulse rate, in radians per millisecond (~1.1 Hz). */
const PULSE_W = (2 * Math.PI * 1.1) / 1000;
/** Danger pulse depth — a gentle ±18% shimmer on top of the eased base. */
const PULSE_AMP = 0.18;

/**
 * How far (in % of the viewport) the damage vignette's focal center is pushed
 * to the OPPOSITE side of an incoming blow, so the reddest edge lands on the
 * side the hit came from.
 */
const DIR_BIAS = 32;

/* -------------------------------------------------------------------------- */
/* ScreenFx                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The local-player feedback overlay. Construct it once with the container to
 * mount into (the same `#app` div the renderer + HUD use), fire {@link infected}
 * / {@link damageFrom} on the matching events, push {@link danger} every frame
 * from nearest-zombie proximity, call {@link update} once per render frame, and
 * {@link dispose} on teardown.
 */
export class ScreenFx {
  /** Root wrapper appended to the container; holds the three effect layers. */
  private readonly root: HTMLDivElement;

  /** Red hit-flash vignette (directional or uniform). */
  private readonly damageLayer: HTMLDivElement;
  /** Green infection bloom (flash + vignette). */
  private readonly infectionLayer: HTMLDivElement;
  /** Persistent red proximity vignette (eased + pulsing). */
  private readonly dangerLayer: HTMLDivElement;

  /** Remaining time (ms) on the current damage flash; 0 when idle. */
  private damageMs = 0;
  /** Remaining time (ms) on the current infection bloom; 0 when idle. */
  private infectMs = 0;

  /** Smoothed danger intensity actually shown (eased toward {@link dangerTarget}). */
  private dangerCur = 0;
  /** Target danger intensity in [0,1], set each frame via {@link danger}. */
  private dangerTarget = 0;
  /** Accumulated phase (ms) driving the danger layer's breathing sine pulse. */
  private dangerPhaseMs = 0;

  constructor(container: HTMLElement) {
    // Full-viewport, click-through wrapper. A moderate z-index (below the perf
    // overlay's 20) keeps the effects above the WebGL canvas; `pointer-events:
    // none` guarantees they never intercept clicks meant for the HUD.
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      userSelect: 'none',
      overflow: 'hidden',
      zIndex: '10',
    } satisfies Partial<CSSStyleDeclaration>);

    // Each layer starts fully transparent; only `opacity` (and the damage
    // layer's gradient, on an event) is ever mutated after construction.
    this.damageLayer = ScreenFx.makeLayer();
    this.damageLayer.style.background = ScreenFx.damageGradient(50, 50);

    this.infectionLayer = ScreenFx.makeLayer();
    // A whole-screen green wash that saturates toward the edges into a vignette.
    this.infectionLayer.style.background =
      `radial-gradient(ellipse at 50% 50%, rgba(${GREEN}, 0.28) 0%, ` +
      `rgba(${GREEN}, 0.12) 45%, rgba(${GREEN_EDGE}, 0.7) 100%)`;

    this.dangerLayer = ScreenFx.makeLayer();
    // A clean inset edge vignette — cheap to fade, no gradient rebuilds needed.
    this.dangerLayer.style.boxShadow = `inset 0 0 240px 60px rgba(${RED}, 0.85)`;

    this.root.append(this.dangerLayer, this.damageLayer, this.infectionLayer);
    container.append(this.root);
  }

  /* ---- Construction helpers -------------------------------------------- */

  /** Build one fixed, full-viewport, click-through effect layer at opacity 0. */
  private static makeLayer(): HTMLDivElement {
    const layer = document.createElement('div');
    Object.assign(layer.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      opacity: '0',
      // Kept out of the layout path; only opacity animates, so this is a hint
      // that the layer's paint can be promoted/cached by the compositor.
      willChange: 'opacity',
    } satisfies Partial<CSSStyleDeclaration>);
    return layer;
  }

  /**
   * A red vignette gradient with a transparent core, focused at `(cx, cy)` in
   * viewport %. The edge farthest from the focus is the reddest, so pushing the
   * focus to the side OPPOSITE a blow lands the saturated band on the hit side.
   */
  private static damageGradient(cx: number, cy: number): string {
    return (
      `radial-gradient(ellipse at ${cx.toFixed(1)}% ${cy.toFixed(1)}%, ` +
      `rgba(${RED}, 0) 30%, rgba(${RED}, 0.9) 100%)`
    );
  }

  /* ---- Events ----------------------------------------------------------- */

  /**
   * Bloom the infection layer to full strength — the local player just turned.
   * This is the loudest, longest-lingering effect: it snaps to {@link INFECT_MAX}
   * and eases out over ~{@link INFECT_MS} ms (see {@link update}).
   */
  infected(): void {
    this.infectMs = INFECT_MS;
    this.infectionLayer.style.opacity = INFECT_MAX.toFixed(3);
  }

  /**
   * Flash the damage layer for a quick (~{@link DAMAGE_MS} ms) red hit pulse.
   *
   * `dirRadians` is the screen-space bearing of the blow, using the convention
   * `0` = from directly in front (top edge), increasing CLOCKWISE (`π/2` = right,
   * `π` = behind/bottom, `-π/2` = left). When given, the vignette biases toward
   * that edge; when omitted, it flashes as a uniform, centered pulse.
   */
  damageFrom(dirRadians?: number): void {
    if (dirRadians === undefined) {
      this.damageLayer.style.background = ScreenFx.damageGradient(50, 50);
    } else {
      // Push the gradient focus to the opposite side of the incoming direction.
      const cx = 50 - Math.sin(dirRadians) * DIR_BIAS;
      const cy = 50 + Math.cos(dirRadians) * DIR_BIAS;
      this.damageLayer.style.background = ScreenFx.damageGradient(cx, cy);
    }
    this.damageMs = DAMAGE_MS;
    this.damageLayer.style.opacity = DAMAGE_MAX.toFixed(3);
  }

  /**
   * Set the target strength of the persistent danger vignette. `intensity` is
   * clamped to [0,1] (typically derived from nearest-zombie proximity) and is
   * approached smoothly in {@link update}, so callers can push a raw value every
   * frame without any snapping.
   */
  danger(intensity: number): void {
    this.dangerTarget = Math.max(0, Math.min(1, intensity));
  }

  /* ---- Per-frame update ------------------------------------------------- */

  /**
   * Advance every layer for one render frame. Decays the transient damage +
   * infection flashes along their own curves (damage falls off fast; infection
   * lingers), then eases the danger layer toward its target and adds a gentle
   * breathing pulse. Only `opacity` is written — no layout, no gradient rebuild.
   */
  update(dtMs: number): void {
    // Guard against tab-switch spikes so a single frame can't slam the fades.
    const dt = Math.max(0, Math.min(dtMs, 100));

    // Damage: instant peak, quick quadratic fall-off over DAMAGE_MS.
    if (this.damageMs > 0) {
      this.damageMs = Math.max(0, this.damageMs - dt);
      const r = this.damageMs / DAMAGE_MS;
      this.damageLayer.style.opacity = (DAMAGE_MAX * r * r).toFixed(3);
    }

    // Infection: instant peak that lingers (sqrt curve) then drops near the end.
    if (this.infectMs > 0) {
      this.infectMs = Math.max(0, this.infectMs - dt);
      const r = this.infectMs / INFECT_MS;
      this.infectionLayer.style.opacity = (INFECT_MAX * Math.sqrt(r)).toFixed(3);
    }

    // Danger: frame-rate-independent ease toward the target + a breathing pulse.
    const k = 1 - Math.exp(-dt / DANGER_TAU);
    this.dangerCur += (this.dangerTarget - this.dangerCur) * k;
    this.dangerPhaseMs += dt;
    const pulse = 1 + PULSE_AMP * Math.sin(this.dangerPhaseMs * PULSE_W);
    const op = Math.max(0, Math.min(1, this.dangerCur * DANGER_MAX * pulse));
    this.dangerLayer.style.opacity = op.toFixed(3);
  }

  /* ---- Teardown --------------------------------------------------------- */

  /** Detach the overlay and reset all transient state. Idempotent. */
  dispose(): void {
    this.root.remove();
    this.damageMs = 0;
    this.infectMs = 0;
    this.dangerCur = 0;
    this.dangerTarget = 0;
    this.dangerPhaseMs = 0;
  }
}
