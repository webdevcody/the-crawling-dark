/**
 * The Crawling Dark — "you have been turned" splash (M17 · t17b).
 *
 * `TurnOverlay` is the brief, centered headline that lands the single worst
 * moment in a survival crawl: the instant the LOCAL player is infected. Where
 * {@link ScreenFx.infected} paints the whole viewport a sickly green, this piece
 * stamps a big, blood-red **YOU HAVE BEEN TURNED** over the middle of the screen
 * for a beat, so the turn reads as an event and not just a color shift. It is a
 * single fixed, click-through DOM node it appends to a container passed in the
 * constructor (the same `#app` div the renderer, HUD, and {@link KillFeed} live
 * in).
 *
 * It is purely time-based: {@link trigger} shows it and resets an internal age,
 * {@link update} advances that age every frame, and the splash holds at full
 * strength for a short beat ({@link HOLD_MS}) before fading its own `opacity`
 * from 1 to 0 over the remainder and hiding itself once the total lifetime
 * ({@link TOTAL_MS}) elapses — nothing has to tell it to go away. The timed fade
 * is computed straight from the elapsed age each frame rather than leaning on a
 * CSS transition, so a re-trigger mid-fade simply restarts the clock and the
 * splash snaps back to full.
 *
 * The node tree is built ONCE in the constructor and hidden until the first
 * {@link trigger}; {@link update} no-ops entirely while hidden and otherwise only
 * writes the one `opacity` value that changed. On a fresh trigger it plays a
 * cheap one-shot scale pop (WAAPI, guarded for jsdom and honoring reduced
 * motion) that touches only `transform`, so it never fights the age-driven
 * opacity. Like the HUD and KillFeed it is `pointer-events: none` /
 * `user-select: none` and depends only on the DOM (no Three.js), sitting above
 * the WebGL canvas without ever stealing clicks.
 */

/* -------------------------------------------------------------------------- */
/* Palette                                                                    */
/* -------------------------------------------------------------------------- */

/** Blood-red — the headline and its glow (mirrors the HUD's "horde" red). */
const RED = '#ff6b6b';
/** Muted slate — the quiet flavor sub-line under the headline. */
const DIM = '#7f8c9a';

/* -------------------------------------------------------------------------- */
/* Timing                                                                     */
/* -------------------------------------------------------------------------- */

/** How long the splash holds at full opacity before it begins to fade (ms). */
const HOLD_MS = 700;
/** Total lifetime (ms): fully visible through {@link HOLD_MS}, faded out by here. */
const TOTAL_MS = 2500;

/** Duration of the one-shot scale pop-in on a fresh trigger (ms). */
const POP_MS = 260;

/* -------------------------------------------------------------------------- */
/* TurnOverlay                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The local-player "turned" splash. Construct it once with the container to
 * mount into (the same `#app` div the renderer lives in), call {@link trigger}
 * the moment the local player is infected, drive {@link update} every render
 * frame to age it out, feed reduced-motion preference via
 * {@link setReducedMotion}, and {@link dispose} on teardown.
 */
export class TurnOverlay {
  /** Fixed, centered, click-through root holding the headline + sub-line. Built once. */
  private readonly root: HTMLDivElement;
  /** Inner wrapper that takes the scale pop, kept off the root's centering transform. */
  private readonly content: HTMLDivElement;

  /** Age of the current splash in ms; only meaningful while {@link visible}. */
  private elapsedMs = 0;
  /** Whether the splash is currently on screen (gates the per-frame no-op). */
  private visible = false;
  /** Last opacity written to the root, so {@link update} can skip no-op DOM writes. */
  private lastAlpha = 1;

  /** Whether to skip the scale pop (set from the user's reduced-motion pref). */
  private reducedMotion = false;
  /** The in-flight pop animation, cancelled on re-trigger / dispose (WAAPI only). */
  private popAnim: Animation | null = null;
  /** Guards against use after {@link dispose} (also makes dispose idempotent). */
  private disposed = false;

  constructor(container: HTMLElement) {
    // Centered, click-through headline (not a full backdrop) sitting a touch
    // above the vertical middle so it reads over the play view. A high-ish
    // z-index keeps it above the ScreenFx layers (z 10) without reaching the
    // perf overlay (z 20). Only `opacity` is mutated after construction.
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'fixed',
      top: '42%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: '17',
      textAlign: 'center',
      pointerEvents: 'none',
      userSelect: 'none',
      willChange: 'opacity',
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.style.display = 'none'; // hidden until the first trigger

    // Inner wrapper: the pop scales THIS about its own center, leaving the root's
    // centering `translate(-50%, -50%)` untouched (animating the root would have
    // to carry the translate through every keyframe).
    this.content = document.createElement('div');
    Object.assign(this.content.style, {
      willChange: 'transform',
    } satisfies Partial<CSSStyleDeclaration>);

    // Headline: big, bold, blood-red monospace with a soft red bloom.
    const headline = document.createElement('div');
    headline.textContent = 'YOU HAVE BEEN TURNED';
    Object.assign(headline.style, {
      font: '700 40px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.06em',
      color: RED,
      textShadow: '0 0 24px #ff6b6bAA',
    } satisfies Partial<CSSStyleDeclaration>);

    // Sub-line: quiet, dim flavor beneath the shout.
    const subline = document.createElement('div');
    subline.textContent = 'the horde claims another';
    Object.assign(subline.style, {
      marginTop: '8px',
      font: '14px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.04em',
      color: DIM,
    } satisfies Partial<CSSStyleDeclaration>);

    this.content.append(headline, subline);
    this.root.append(this.content);
    container.append(this.root);
  }

  /* ---- Events ----------------------------------------------------------- */

  /**
   * Fire the splash — the local player just turned. Snaps to full opacity,
   * restarts the internal age at 0 (so re-triggering mid-fade cleanly restarts
   * the beat), reveals the root, and — unless reduced motion is set — plays a
   * one-shot scale pop. The pop touches only `transform`, so it never fights the
   * age-driven `opacity` {@link update} manages. Guarded for environments without
   * the Web Animations API (e.g. jsdom in tests).
   */
  trigger(): void {
    if (this.disposed) return;

    this.elapsedMs = 0;
    this.visible = true;
    this.lastAlpha = 1;
    this.root.style.opacity = '1';
    this.root.style.display = 'block';

    // Cancel any pop still settling from a previous trigger before starting a
    // fresh one, so overlapping turns don't stack transforms.
    this.popAnim?.cancel();
    this.popAnim = null;
    if (!this.reducedMotion) {
      this.popAnim =
        this.content.animate?.(
          [{ transform: 'scale(0.82)' }, { transform: 'scale(1)' }],
          { duration: POP_MS, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
        ) ?? null;
    }
  }

  /**
   * Toggle whether the scale pop plays on {@link trigger}. Mirrors the user's
   * reduced-motion preference: when `true`, {@link trigger} still shows and fades
   * the splash (the timed opacity fade is essential feedback, not decoration) but
   * skips the pop-in entirely.
   */
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  /* ---- Per-frame update ------------------------------------------------- */

  /**
   * Advance the splash by `dtMs`. A no-op while hidden. Otherwise ages the
   * internal clock (capped per frame so a tab-switch spike can't skip the whole
   * splash in one step), holds full opacity through {@link HOLD_MS}, then fades
   * `opacity` linearly from 1 to 0 across the remainder, and hides the root once
   * the age reaches {@link TOTAL_MS}. Opacity is computed straight from the age
   * and written only when it actually moved, so a settled splash does no work.
   */
  update(dtMs: number): void {
    if (this.disposed || !this.visible) return;

    // Guard against tab-switch spikes so a single frame can't slam the fade.
    this.elapsedMs += Math.max(0, Math.min(dtMs, 100));

    if (this.elapsedMs >= TOTAL_MS) {
      this.hide();
      return;
    }

    const alpha =
      this.elapsedMs <= HOLD_MS
        ? 1
        : Math.max(0, 1 - (this.elapsedMs - HOLD_MS) / (TOTAL_MS - HOLD_MS));
    if (Math.abs(alpha - this.lastAlpha) > 0.005) {
      this.root.style.opacity = alpha.toFixed(3);
      this.lastAlpha = alpha;
    }
  }

  /* ---- Internal --------------------------------------------------------- */

  /** Fully retire the splash: mark it hidden and drop the root out of layout. */
  private hide(): void {
    this.visible = false;
    this.root.style.display = 'none';
  }

  /* ---- Teardown --------------------------------------------------------- */

  /** Cancel any in-flight pop and detach the splash from the container. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.popAnim?.cancel();
    this.popAnim = null;
    this.root.remove();
  }
}
