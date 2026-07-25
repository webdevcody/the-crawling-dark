/**
 * The Crawling Dark — round-start role reveal intro (M17 · t17c).
 *
 * `RoundIntro` is the transient, center-screen ROLE-REVEAL splash that flashes
 * when a round begins — a one-time, dramatic "here is who you are tonight"
 * moment (SURVIVE THE NIGHT · You are HUMAN / the HORDE), deliberately distinct
 * from the persistent bottom-center objective banner that lives in
 * {@link Reticle}. It is a single fixed, click-through DOM card it appends to a
 * container passed in the constructor (the same `#app` div the renderer, HUD,
 * {@link ScreenFx}, and {@link KillFeed} live in).
 *
 * It is fire-and-forget and purely time-based: {@link trigger} shows the card
 * for the current round — setting the headline glow, the team line, and the
 * accent color from your team — and {@link update}, called every render frame,
 * ages it out. The card holds at full strength for {@link HOLD_MS}, then fades
 * `opacity` 1->0 over the remainder before hiding itself once {@link TOTAL_MS}
 * has elapsed. That fade is computed straight from the accumulated `elapsedMs`
 * (never a CSS transition), so it stays correct regardless of frame timing;
 * re-triggering simply restarts the timer and re-renders the content.
 *
 * The card is built ONCE in the constructor and hidden until the first
 * {@link trigger}; per frame {@link update} only writes the handful of `opacity`
 * / visibility values that actually changed (caching the last written opacity),
 * so a running intro never allocates or re-parents DOM. When motion is allowed
 * it plays a cheap one-shot fade + slide-in via the Web Animations API (guarded
 * for jsdom / older engines, exactly like {@link KillFeed}); {@link setReducedMotion}
 * turns that entrance off for players who prefer no motion, while leaving the
 * timed opacity fade fully intact.
 *
 * Like the rest of the client's UI it depends only on the DOM + shared wire
 * types (no Three.js), and is `pointer-events: none` / `user-select: none`, so
 * it sits above the WebGL canvas without ever stealing clicks from the HUD.
 */

import type { EntityKind } from '@crawling-dark/shared';

/* -------------------------------------------------------------------------- */
/* Timing constants                                                           */
/* -------------------------------------------------------------------------- */

/** How long the splash holds at full opacity before it starts fading, in ms. */
export const HOLD_MS = 1800;

/** Total lifetime of the splash — hold + fade — after which it hides, in ms. */
export const TOTAL_MS = 3200;

/* -------------------------------------------------------------------------- */
/* Palette (mirrors the HUD's round/team semantics)                           */
/* -------------------------------------------------------------------------- */

/** Hopeful green — you are human, outlast the horde. */
const GREEN = '#53ffa8';
/** Ominous red — you are the horde, hunt them all. */
const RED = '#ff6b6b';
/** Calm slate — the bright headline text + the neutral (pre-team) accent. */
const SLATE = '#c8d6e5';
/** Muted slate — the team line when you have no side yet (spectating / null). */
const DIM = '#7f8c9a';

/** The fixed rallying cry — the headline never changes, only its glow does. */
const HEADLINE = 'SURVIVE THE NIGHT';

/* -------------------------------------------------------------------------- */
/* Role -> reveal copy + colors                                               */
/* -------------------------------------------------------------------------- */

/**
 * The per-role reveal: the team line's text, the {@link Reveal.accent} that
 * tints the headline glow + card border, and the {@link Reveal.lineColor} the
 * team line renders in. Human/zombie blaze in their side's color; a `null` team
 * (pre-spawn / spectating) reads muted, with a neutral slate glow and a dimmed
 * line.
 */
interface Reveal {
  /** The supporting line under the headline (e.g. "You are HUMAN — …"). */
  readonly line: string;
  /** Accent tinting the headline glow + card border for this role. */
  readonly accent: string;
  /** Text color for the team line itself. */
  readonly lineColor: string;
}

/** Resolve the reveal copy + colors for a team (`null` = no side yet). */
function revealFor(team: EntityKind | null): Reveal {
  switch (team) {
    case 'human':
      return { line: 'You are HUMAN — outlast the horde', accent: GREEN, lineColor: GREEN };
    case 'zombie':
      return { line: 'You are the HORDE — hunt them all', accent: RED, lineColor: RED };
    default:
      return { line: 'The night begins', accent: SLATE, lineColor: DIM };
  }
}

/* -------------------------------------------------------------------------- */
/* RoundIntro                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The round-start role-reveal splash. Construct it once with the container to
 * mount into (the same `#app` div the renderer lives in), {@link trigger} it
 * with the local player's team when a round begins, call {@link update} every
 * render frame to age it out, {@link setReducedMotion} to honor a motion
 * preference, and {@link dispose} on teardown.
 */
export class RoundIntro {
  /** Fixed, click-through centered card holding the headline + team line. */
  private readonly card: HTMLDivElement;
  /** Big constant headline; only its accent glow changes per trigger. */
  private readonly headline: HTMLDivElement;
  /** The per-role reveal line (text + color set on each {@link trigger}). */
  private readonly teamLine: HTMLDivElement;

  /** Time (ms) since the current trigger; drives the hold-then-fade timeline. */
  private elapsedMs = 0;
  /** Whether the card is currently shown; {@link update} is a no-op while false. */
  private visible = false;
  /** Last `opacity` written, so a steady frame skips the redundant DOM write. */
  private lastOpacity = 1;
  /** When true, skip the one-shot entrance animation (timed fade stays on). */
  private reducedMotion = false;
  /** Guards against use after {@link dispose} (also makes dispose idempotent). */
  private disposed = false;

  constructor(container: HTMLElement) {
    // A centered, translucent, click-through card sitting a touch above screen
    // center. zIndex 16 keeps it above the ScreenFx flashes (10) yet below the
    // perf overlay (20); pointer-events: none guarantees it never steals clicks.
    this.card = document.createElement('div');
    Object.assign(this.card.style, {
      position: 'fixed',
      top: '38%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: '16',
      padding: '16px 30px',
      minWidth: '300px',
      textAlign: 'center',
      background: 'rgba(5, 7, 10, 0.78)',
      border: '1px solid rgba(58, 90, 106, 0.5)',
      borderRadius: '10px',
      backdropFilter: 'blur(3px)',
      pointerEvents: 'none',
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    this.card.style.display = 'none'; // hidden until the first trigger

    // Headline: big bold monospace. Its text is constant; only the accent glow
    // (textShadow) is retinted per role, so the color stays a bright, readable
    // slate at all times.
    this.headline = document.createElement('div');
    Object.assign(this.headline.style, {
      font: '700 30px/1.15 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.05em',
      color: SLATE,
    } satisfies Partial<CSSStyleDeclaration>);
    this.headline.textContent = HEADLINE;

    // Team line: the actual role reveal — its text + color are set on trigger.
    this.teamLine = document.createElement('div');
    Object.assign(this.teamLine.style, {
      marginTop: '8px',
      fontSize: '15px',
      color: DIM,
    } satisfies Partial<CSSStyleDeclaration>);

    this.card.append(this.headline, this.teamLine);
    container.append(this.card);
  }

  /* ---- Events ----------------------------------------------------------- */

  /**
   * Reveal the role splash for a round that is starting. Renders the team line +
   * accent from `team` (human -> green, zombie -> red, `null` -> neutral slate),
   * retints the headline glow and card border, resets the hold/fade timer to 0,
   * and shows the card at full opacity. Unless reduced motion is set, it plays a
   * cheap one-shot fade + slide-in (guarded via the Web Animations API). Calling
   * it again while still visible restarts the timeline and re-renders in place.
   */
  trigger(team: EntityKind | null): void {
    if (this.disposed) return;

    const { line, accent, lineColor } = revealFor(team);
    this.headline.style.textShadow = `0 0 20px ${accent}66`;
    this.card.style.borderColor = accent;
    this.teamLine.textContent = line;
    this.teamLine.style.color = lineColor;

    // Restart the timeline and snap back to full strength.
    this.elapsedMs = 0;
    this.lastOpacity = 1;
    this.card.style.opacity = '1';
    this.card.style.display = 'block';
    this.visible = true;

    // A dramatic-but-cheap enter: fade + slide up + tiny scale, all folded into
    // the base centering transform so the card never jumps off-center mid-flight.
    // Skipped under reduced motion; guarded for engines without WAAPI (jsdom).
    if (!this.reducedMotion) {
      this.card.animate?.(
        [
          { opacity: 0, transform: 'translate(-50%, -50%) translateY(10px) scale(0.96)' },
          { opacity: 1, transform: 'translate(-50%, -50%) translateY(0) scale(1)' },
        ],
        { duration: 360, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
      );
    }
  }

  /* ---- Per-frame update ------------------------------------------------- */

  /**
   * Age the splash by `dtMs`. A no-op while hidden. Accumulates `elapsedMs`,
   * holds full opacity through {@link HOLD_MS}, then fades linearly to 0 over the
   * remaining window, and hides the card once {@link TOTAL_MS} has elapsed. The
   * opacity is derived straight from `elapsedMs` (not a CSS transition) and only
   * written when it actually moved, so a holding splash does no DOM work.
   */
  update(dtMs: number): void {
    if (this.disposed || !this.visible) return;

    this.elapsedMs += dtMs;

    // Fully aged out: hide and stop until the next trigger.
    if (this.elapsedMs >= TOTAL_MS) {
      this.card.style.display = 'none';
      this.visible = false;
      return;
    }

    // Hold, then linear fade over the remaining (TOTAL_MS - HOLD_MS) window.
    const fadeMs = TOTAL_MS - HOLD_MS;
    const opacity =
      this.elapsedMs <= HOLD_MS
        ? 1
        : Math.max(0, 1 - (this.elapsedMs - HOLD_MS) / fadeMs);

    if (Math.abs(opacity - this.lastOpacity) > 0.005) {
      this.card.style.opacity = opacity.toFixed(3);
      this.lastOpacity = opacity;
    }
  }

  /* ---- Preferences ------------------------------------------------------ */

  /**
   * Set the reduced-motion preference. When enabled, {@link trigger} skips the
   * one-shot slide-in entrance; the timed hold-then-fade in {@link update} is
   * unaffected, so the splash still appears and ages out normally.
   */
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  /* ---- Teardown --------------------------------------------------------- */

  /** Remove the card from the container. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visible = false;
    this.card.remove();
  }
}
