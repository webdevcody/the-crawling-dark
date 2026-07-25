/**
 * The Crawling Dark — round-end results screen (M17 · t17a).
 *
 * `RoundEndScreen` is the prominent, viewport-centered **summary card** shown
 * while a round has finished (`round.phase === 'ended'`). It is the richer, more
 * cinematic cousin of the HUD's small top-center results banner: where that
 * banner keeps a one-line headline out of the way at the top, this overlay takes
 * the middle of the screen for a beat and spells out how the match actually went
 * — the big winner headline, *your* personal fate, the final human/zombie tally,
 * and a live "returning to lobby" countdown — before the loop drops everyone
 * back into the lobby. It is a pure presentation layer: a fixed, click-through
 * (`pointer-events: none`) card it appends to a container passed in the
 * constructor (the same `#app` div the renderer, {@link HUD}, and
 * {@link Reticle} live in).
 *
 * The whole element tree is built ONCE in the constructor and hidden
 * (`display: none`) until a round ends. {@link update} (called once per render
 * frame) shows the card only while `round.phase === 'ended'` and hides it the
 * rest of the time; while hidden it does nothing at all — no allocation, no DOM
 * writes. When the card FIRST appears for a given ended round it plays a single
 * fade + scale-in (a WAAPI one-shot, guarded for environments without the Web
 * Animations API and skipped entirely under reduced-motion), tracked so it fires
 * once per transition into `ended` rather than every frame. Content nodes are
 * cached and their `textContent` / colors are only rewritten when the underlying
 * value actually changes, so a settled results card does no per-frame DOM work.
 *
 * Like the HUD and Reticle it deliberately depends only on the DOM + shared wire
 * types (no Three.js), mirroring the render-agnostic split the rest of the
 * client's UI uses, and it sits at a higher z-index than the in-play overlays so
 * the summary reads clearly above the frozen scene and any screen effects.
 */

import { type EntityKind, type RoundMessage } from '@crawling-dark/shared';

/* -------------------------------------------------------------------------- */
/* Public state contract                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything {@link RoundEndScreen.update} needs for one frame. Assembled by the
 * render loop from the latest ROUND frame and the local player's team (derived
 * from its entity `kind`). At round end a surviving player's team reads `human`
 * and a turned player's reads `zombie`, so the personal result line below is
 * correct straight off `team` with no extra bookkeeping.
 */
export interface RoundEndState {
  /** Latest ROUND frame, or `null` before the first one / after a disconnect. */
  round: RoundMessage | null;
  /** The local player's team, or `null` before we spawn / while spectating. */
  team: EntityKind | null;
}

/* -------------------------------------------------------------------------- */
/* Palette                                                                    */
/* -------------------------------------------------------------------------- */

/** Hopeful green — humans survived the night. */
const GREEN = '#53ffa8';
/** Ominous red — the horde wins. */
const RED = '#ff6b6b';
/** Energetic amber — the live "returning to lobby" countdown. */
const AMBER = '#ffd24a';
/** Calm slate — the resting text color / a neutral, winner-less result. */
const SLATE = '#c8d6e5';
/** Muted slate — the secondary tally line. */
const DIM = '#7f8c9a';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whole seconds remaining (ceil, clamped to 0), for the "returning to lobby in
 * Ns" copy. A tiny local reimplementation of the HUD's helper of the same name,
 * so the two countdowns stay in lock-step without a cross-module dependency.
 */
function secondsLeft(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

/* -------------------------------------------------------------------------- */
/* RoundEndScreen                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The centered round-end results overlay. Construct it once with the container
 * to mount into (the same `#app` div the renderer lives in), call {@link update}
 * every render frame, toggle {@link setReducedMotion} to match the player's
 * accessibility preference, and {@link dispose} on teardown.
 */
export class RoundEndScreen {
  /* ---- DOM (built once) ------------------------------------------------- */
  /** Fixed, centered, click-through card wrapping the whole summary. */
  private readonly card: HTMLDivElement;
  /** Big winner headline — its text, color, and glow track the outcome. */
  private readonly headlineEl: HTMLDivElement;
  /** The local player's personal result line ("You survived the night", …). */
  private readonly resultEl: HTMLDivElement;
  /** The final human/zombie tally, in a muted secondary style. */
  private readonly tallyEl: HTMLDivElement;
  /** The live "returning to lobby in Ns" countdown line. */
  private readonly countdownEl: HTMLDivElement;

  /* ---- Cached render state --------------------------------------------- */
  /**
   * Last-written visibility, and the one-shot-entrance latch in one: `null`
   * before the first frame, then `true` while the card is up and `false` while
   * hidden. The `false -> true` flip is exactly one transition into `ended`, so
   * that is where the entrance animation fires — once per ended round, never per
   * frame.
   */
  private lastShown: boolean | null = null;
  /** Whether reduced-motion is on — when set, the entrance animation is skipped. */
  private reducedMotion = false;

  // Last-written content, so a settled card does no per-frame DOM writes.
  private lastHeadline = '';
  private lastAccent = '';
  private lastResult = '';
  private lastTally = '';
  private lastCountdown = '';

  constructor(container: HTMLElement) {
    // A prominent, viewport-centered, translucent, click-through card. The
    // z-index (15) sits above the in-play overlays — ScreenFx's effect layers
    // (10) and the Reticle (11) — so the summary reads clearly over the frozen
    // scene and any lingering vignette; `pointer-events: none` keeps it
    // click-through despite covering the middle of the screen.
    this.card = document.createElement('div');
    Object.assign(this.card.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: '15',
      padding: '28px 44px',
      minWidth: '320px',
      font: '13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      textAlign: 'center',
      color: SLATE,
      background: 'rgba(5, 7, 10, 0.82)',
      border: '1px solid rgba(58, 90, 106, 0.5)',
      borderRadius: '10px',
      backdropFilter: 'blur(3px)',
      pointerEvents: 'none',
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    this.card.style.display = 'none'; // hidden until a round ends

    // Big outcome headline — mirrors the HUD banner's title scale so the two
    // read as one system; its color + glow are set per-outcome in `update`.
    this.headlineEl = document.createElement('div');
    Object.assign(this.headlineEl.style, {
      font: '700 34px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.04em',
      color: SLATE,
    } satisfies Partial<CSSStyleDeclaration>);

    // Personal result — a touch smaller, in the resting slate.
    this.resultEl = document.createElement('div');
    Object.assign(this.resultEl.style, {
      marginTop: '12px',
      fontSize: '15px',
      color: SLATE,
    } satisfies Partial<CSSStyleDeclaration>);

    // Final tally — muted, secondary.
    this.tallyEl = document.createElement('div');
    Object.assign(this.tallyEl.style, {
      marginTop: '10px',
      fontSize: '13px',
      color: DIM,
    } satisfies Partial<CSSStyleDeclaration>);

    // Countdown back to the lobby — amber, the game's "energetic countdown" hue.
    this.countdownEl = document.createElement('div');
    Object.assign(this.countdownEl.style, {
      marginTop: '6px',
      fontSize: '13px',
      color: AMBER,
    } satisfies Partial<CSSStyleDeclaration>);

    this.card.append(this.headlineEl, this.resultEl, this.tallyEl, this.countdownEl);
    container.append(this.card);
  }

  /* ---- Per-frame update ------------------------------------------------- */

  /**
   * Refresh the card for one frame. Shows it only while `round.phase === 'ended'`
   * and hides it otherwise; while hidden it returns immediately without touching
   * the DOM. On the first frame of a given ended round it reveals the card and
   * plays the one-shot entrance (see {@link playEntrance}). Content is written
   * only where a value actually changed since last frame — the headline text +
   * accent, the personal result, the tally, and the once-a-second countdown — so
   * a settled results card does no per-frame DOM work.
   */
  update(state: RoundEndState): void {
    const { round, team } = state;

    // Hide (and re-arm the entrance latch) whenever we're not on an ended round.
    if (round === null || round.phase !== 'ended') {
      if (this.lastShown !== false) {
        this.card.style.display = 'none';
        this.lastShown = false;
      }
      return;
    }

    // First frame of this ended round: reveal + play the one-shot entrance once.
    if (this.lastShown !== true) {
      this.card.style.display = 'block';
      this.lastShown = true;
      this.playEntrance();
    }

    // Outcome headline + accent — the accent drives the text color, the banner
    // glow, and the card's border tint, exactly like the HUD's results banner.
    let headline: string;
    let accent: string;
    if (round.winner === 'human') {
      headline = 'HUMANS SURVIVED';
      accent = GREEN;
    } else if (round.winner === 'zombie') {
      headline = 'THE HORDE WINS';
      accent = RED;
    } else {
      headline = 'ROUND OVER';
      accent = SLATE;
    }
    if (headline !== this.lastHeadline) {
      this.headlineEl.textContent = headline;
      this.lastHeadline = headline;
    }
    if (accent !== this.lastAccent) {
      this.headlineEl.style.color = accent;
      this.headlineEl.style.textShadow = `0 0 18px ${accent}66`;
      this.card.style.borderColor = `${accent}55`;
      this.lastAccent = accent;
    }

    // Personal result — read straight off the local team (which at round end is
    // `human` for survivors, `zombie` for the turned, `null` while spectating).
    const result =
      team === 'human'
        ? 'You survived the night'
        : team === 'zombie'
          ? 'You were turned'
          : 'Spectating';
    if (result !== this.lastResult) {
      this.resultEl.textContent = result;
      this.lastResult = result;
    }

    // Final tally, in the HUD's muted secondary voice.
    const tally = `humans ${round.humansAlive} · zombies ${round.zombieCount}`;
    if (tally !== this.lastTally) {
      this.tallyEl.textContent = tally;
      this.lastTally = tally;
    }

    // Countdown back to the lobby (ticks ~once a second).
    const countdown = `Returning to lobby in ${secondsLeft(round.timeLeftMs)}s`;
    if (countdown !== this.lastCountdown) {
      this.countdownEl.textContent = countdown;
      this.lastCountdown = countdown;
    }
  }

  /**
   * Play the one-shot fade + scale-in used when the card first appears for an
   * ended round. A gentle WAAPI entrance that touches only `opacity` and
   * `transform` (preserving the centering translate so the card stays put), so
   * it never fights the static inline style once it settles. Guarded for
   * environments without the Web Animations API (e.g. jsdom in tests) and
   * skipped outright under reduced-motion — then the card simply appears.
   */
  private playEntrance(): void {
    if (this.reducedMotion) return;
    this.card.animate?.(
      [
        { opacity: 0, transform: 'translate(-50%, -50%) scale(0.92)' },
        { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' },
      ],
      { duration: 260, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
    );
  }

  /* ---- Accessibility + teardown ---------------------------------------- */

  /**
   * Set the reduced-motion preference. When `true`, the entrance animation is
   * skipped and the card just appears; content updates are unaffected. Safe to
   * call at any time — it only gates the *next* entrance.
   */
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  /** Remove the card from the container. Idempotent. */
  dispose(): void {
    this.card.remove();
  }
}
