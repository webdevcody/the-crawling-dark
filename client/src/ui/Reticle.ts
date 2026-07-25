/**
 * The Crawling Dark — combat reticle + objective banner (M15 · t15d).
 *
 * `Reticle` is the self-contained, center-of-screen crosshair the LOCAL player
 * aims their bat with, paired with a compact one-line objective banner near the
 * bottom-center. Both are fixed, click-through DOM pieces it appends to a
 * container passed in the constructor (the same `#app` div the renderer, HUD,
 * and {@link ScreenFx} live in):
 *
 *   - a **center crosshair** — an inline `<svg>` reticle (four ticks + a center
 *     dot ringed by a recharge arc) that reads bat-swing readiness at a glance.
 *     When you swing ({@link onSwing}) it snaps to a dimmed, RED, shrunken
 *     "charging" look with an empty arc; as the {@link ATTACK_COOLDOWN_MS} cool-
 *     down burns down each {@link update}, the arc sweeps closed and the reticle
 *     grows + brightens back to a ready, full-size GREEN crosshair at 0.
 *   - a **bottom-center objective banner** — a single phase-driven line telling
 *     you what to actually do right now: ready up, get ready, survive the clock,
 *     infect the survivors, or the round result.
 *
 * Every node is built ONCE in the constructor. Per frame {@link update} only
 * mutates cached nodes' `textContent`, colors, `opacity`, `display`, and a
 * couple of SVG attributes (the arc's `stroke-dashoffset`, a scale transform) —
 * and it caches its last-written values so it only touches the DOM when a value
 * actually changes. In steady state (ready + idle, or hidden) it does no writes
 * at all; while charging it animates a handful of numbers, exactly like the
 * transient flashes in {@link ScreenFx}. No nodes are ever created or re-parented
 * after construction.
 *
 * Like the HUD and ScreenFx it deliberately depends only on the DOM + shared
 * wire types (no Three.js), mirroring the render-agnostic split the rest of the
 * client's UI uses. Both pieces are `pointer-events: none` / `user-select: none`,
 * so they sit above the WebGL canvas without ever stealing clicks from the
 * interactive HUD.
 */

import { ATTACK_COOLDOWN_MS, type EntityKind, type RoundMessage } from '@crawling-dark/shared';

/* -------------------------------------------------------------------------- */
/* Public state contract                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything {@link Reticle.update} needs for one frame. Assembled by the render
 * loop from the latest ROUND frame, the local player's team (derived from its
 * entity `kind`), and whether the pointer is currently locked (i.e. we're
 * actually mouse-looking / playing rather than sitting in a menu).
 */
export interface ReticleState {
  /** Latest ROUND frame, or `null` before the first one / after a disconnect. */
  round: RoundMessage | null;
  /** The local player's team, or `null` before we spawn / while spectating. */
  team: EntityKind | null;
  /** Whether the pointer is locked — the crosshair only shows while playing. */
  pointerLocked: boolean;
}

/* -------------------------------------------------------------------------- */
/* Palette + helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Hopeful green — a ready bat, humans surviving, your own highlight. */
const GREEN = '#53ffa8';
/** Ominous red — a swing on cooldown, the horde, danger. */
const RED = '#ff6b6b';
/** Energetic amber — the recharge sweep and the countdown. */
const AMBER = '#ffd24a';
/** Calm slate — the resting text color / neutral objective. */
const SLATE = '#c8d6e5';
/** Muted slate — the static recharge track and placeholder copy. */
const DIM = '#7f8c9a';

/** SVG namespace, so the inline reticle's nodes are created correctly. */
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Radius (in viewBox units) of the recharge ring the reticle spins closed. */
const RING_R = 30;
/** Circumference of the recharge ring — the arc's full dash length. */
const RING_C = 2 * Math.PI * RING_R;

/**
 * Format a millisecond duration as `M:SS` (e.g. `247000` -> `4:07`). Uses `ceil`
 * so a fresh 5:00 round reads `5:00` and only hits `0:00` at the very end, and
 * clamps negatives to `0:00`. Matches the HUD's clock so the objective's
 * `Survive M:SS` line stays in lock-step with the big round timer above it.
 */
function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Reticle                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The combat crosshair + objective overlay. Construct it once with the container
 * to mount into (the same `#app` div the renderer lives in), fire {@link onSwing}
 * whenever the LOCAL player sends a bat swing, call {@link update} every render
 * frame, and {@link dispose} on teardown. {@link setVisible} is a master switch
 * integration uses to hide the whole thing (e.g. while a menu is up).
 */
export class Reticle {
  /* ---- Center crosshair ------------------------------------------------- */
  /** Fixed, viewport-centered wrapper holding the inline reticle `<svg>`. */
  private readonly crossRoot: HTMLDivElement;
  /** The sweeping recharge arc — only its `stroke-dashoffset` + color mutate. */
  private readonly ringArc: SVGElement;
  /** The tick lines + center dot, recolored together on a readiness flip. */
  private readonly marks: SVGElement[] = [];

  /* ---- Objective banner (bottom-center) -------------------------------- */
  private readonly banner: HTMLDivElement;

  /* ---- Cooldown + cached render state ----------------------------------- */
  /** Remaining bat-swing cooldown (ms); 0 = ready. Counts down in {@link update}. */
  private cooldownMs = 0;
  /** Master visibility switch (see {@link setVisible}); gates both pieces. */
  private visible = true;

  // Last-written values, so per-frame refreshes only touch the DOM on a change.
  private lastReady = true;
  private lastCrossShown: boolean | null = null;
  private lastBannerShown: boolean | null = null;
  private lastScale = -1;
  private lastArcOffset = -1;
  private lastCrossOpacity = -1;
  private lastObjText = '';
  private lastObjColor = '';

  constructor(container: HTMLElement) {
    /* -- Center crosshair ------------------------------------------------- */
    // A small, viewport-centered, click-through wrapper. The z-index sits just
    // above ScreenFx's effect layers (10) so the crosshair stays legible through
    // a damage/danger vignette; `pointer-events: none` keeps it click-through.
    this.crossRoot = document.createElement('div');
    Object.assign(this.crossRoot.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      pointerEvents: 'none',
      userSelect: 'none',
      zIndex: '11',
      // Only opacity + transform animate; hint the compositor to cache the paint.
      willChange: 'opacity, transform',
    } satisfies Partial<CSSStyleDeclaration>);

    // Inline SVG reticle in a 100x100 viewBox, centered on (50, 50).
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('width', '56');
    svg.setAttribute('height', '56');
    svg.style.display = 'block';
    svg.style.overflow = 'visible';

    // Static recharge track: a faint full ring the arc sweeps closed over.
    const ringTrack = Reticle.svgEl('circle', {
      cx: '50',
      cy: '50',
      r: String(RING_R),
      fill: 'none',
      stroke: DIM,
      'stroke-width': '2',
      'stroke-opacity': '0.35',
    });

    // The recharge arc: same ring, dashed to `RING_C` so `stroke-dashoffset`
    // hides/reveals it as a sweep. Rotated -90° so it fills from the top.
    this.ringArc = Reticle.svgEl('circle', {
      cx: '50',
      cy: '50',
      r: String(RING_R),
      fill: 'none',
      stroke: GREEN,
      'stroke-width': '3',
      'stroke-linecap': 'round',
      'stroke-dasharray': RING_C.toFixed(2),
      'stroke-dashoffset': '0',
      transform: 'rotate(-90 50 50)',
    });

    // Four ticks around a small central gap + a center dot. Recolored as one
    // group (via {@link marks}) whenever readiness flips.
    const tick = (x1: number, y1: number, x2: number, y2: number): SVGElement =>
      Reticle.svgEl('line', {
        x1: String(x1),
        y1: String(y1),
        x2: String(x2),
        y2: String(y2),
        stroke: GREEN,
        'stroke-width': '4',
        'stroke-linecap': 'round',
      });
    const dot = Reticle.svgEl('circle', { cx: '50', cy: '50', r: '2', fill: GREEN });
    this.marks.push(
      tick(50, 16, 50, 32), // top
      tick(50, 68, 50, 84), // bottom
      tick(16, 50, 32, 50), // left
      tick(68, 50, 84, 50), // right
      dot,
    );

    svg.append(ringTrack, this.ringArc, ...this.marks);
    this.crossRoot.append(svg);
    container.append(this.crossRoot);

    /* -- Bottom-center objective banner ---------------------------------- */
    // A compact, translucent, click-through line pinned above the very bottom of
    // the screen (clear of where the rest of the HUD lives), mirroring the HUD's
    // panel look so the two read as one system.
    this.banner = document.createElement('div');
    Object.assign(this.banner.style, {
      position: 'fixed',
      bottom: '12%',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '6px 16px',
      font: '700 14px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.03em',
      textAlign: 'center',
      color: SLATE,
      background: 'rgba(5, 7, 10, 0.6)',
      border: '1px solid rgba(58, 90, 106, 0.5)',
      borderRadius: '6px',
      pointerEvents: 'none',
      userSelect: 'none',
      whiteSpace: 'nowrap',
      backdropFilter: 'blur(2px)',
      zIndex: '11',
    } satisfies Partial<CSSStyleDeclaration>);
    container.append(this.banner);
  }

  /* ---- Construction helpers -------------------------------------------- */

  /** Create one SVG element and set a bag of attributes on it in one go. */
  private static svgEl(tag: string, attrs: Record<string, string>): SVGElement {
    const el = document.createElementNS(SVG_NS, tag);
    for (const name in attrs) el.setAttribute(name, attrs[name]);
    return el;
  }

  /* ---- Events ----------------------------------------------------------- */

  /**
   * Arm the swing cooldown — the LOCAL player just swung their bat. Snaps the
   * cooldown to {@link ATTACK_COOLDOWN_MS}, so the very next {@link update} shows
   * the reticle as freshly-emptied and charging; it recharges to ready as the
   * timer burns down. Calling it again mid-cooldown simply re-arms from full.
   */
  onSwing(): void {
    this.cooldownMs = ATTACK_COOLDOWN_MS;
  }

  /* ---- Per-frame update ------------------------------------------------- */

  /**
   * Advance the cooldown by `dtMs` and refresh both pieces for one frame. Burns
   * the swing cooldown toward 0 (guarded against tab-switch spikes), then repaints
   * the crosshair's recharge/readiness look and recomputes the objective line —
   * writing to the DOM only where a value actually changed since last frame.
   */
  update(dtMs: number, state: ReticleState): void {
    const dt = Math.max(0, Math.min(dtMs, 100));
    if (this.cooldownMs > 0) this.cooldownMs = Math.max(0, this.cooldownMs - dt);

    this.renderCrosshair(state);
    this.renderObjective(state.round, state.team);
  }

  /**
   * Show the crosshair only while actually playing — the pointer is locked, the
   * master switch is on, and we're not sitting in the lobby or on a results
   * banner — then map the remaining cooldown to the reticle's size, brightness,
   * recharge sweep, and ready/charging color.
   */
  private renderCrosshair(state: ReticleState): void {
    const phase = state.round?.phase;
    const playing = state.round === null || (phase !== 'lobby' && phase !== 'ended');
    const shown = this.visible && state.pointerLocked && playing;

    if (shown !== this.lastCrossShown) {
      this.crossRoot.style.display = shown ? 'block' : 'none';
      this.lastCrossShown = shown;
    }
    if (!shown) return;

    // Cooldown maps to a 0 (just swung) -> 1 (ready) recharge fraction.
    const ready = this.cooldownMs <= 0;
    const progress = ready ? 1 : 1 - this.cooldownMs / ATTACK_COOLDOWN_MS;

    // Arc sweeps closed as it recharges; empty (full offset) right after a swing.
    const arcOffset = RING_C * (1 - progress);
    if (Math.abs(arcOffset - this.lastArcOffset) > 0.05) {
      this.ringArc.setAttribute('stroke-dashoffset', arcOffset.toFixed(2));
      this.lastArcOffset = arcOffset;
    }

    // Grow from a shrunken 0.7 up to full size, and brighten from dim to solid,
    // as the swing recharges. Both are static (no writes) once ready.
    const scale = ready ? 1 : 0.7 + 0.3 * progress;
    if (Math.abs(scale - this.lastScale) > 0.002) {
      this.crossRoot.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
      this.lastScale = scale;
    }
    const opacity = ready ? 1 : 0.5 + 0.5 * progress;
    if (Math.abs(opacity - this.lastCrossOpacity) > 0.005) {
      this.crossRoot.style.opacity = opacity.toFixed(3);
      this.lastCrossOpacity = opacity;
    }

    // Color only flips between the two discrete states, so recolor the ticks +
    // dot + arc (and the ready glow) once per readiness change, never per frame.
    if (ready !== this.lastReady) {
      const markColor = ready ? GREEN : RED;
      for (const m of this.marks) {
        if (m.tagName === 'line') m.setAttribute('stroke', markColor);
        else m.setAttribute('fill', markColor);
      }
      this.ringArc.setAttribute('stroke', ready ? GREEN : AMBER);
      this.crossRoot.style.filter = ready ? `drop-shadow(0 0 4px ${GREEN}aa)` : 'none';
      this.lastReady = ready;
    }
  }

  /**
   * Recompute the one-line objective off the round `phase` + local `team`:
   * ready up in the lobby, "get ready" on the countdown, the surviving clock or
   * an infect prompt during play, and a winner-aware result at the end. Writes
   * the text/color only when they actually change (the clock ticks ~once a sec).
   */
  private renderObjective(round: RoundMessage | null, team: EntityKind | null): void {
    const bannerShown = this.visible;
    if (bannerShown !== this.lastBannerShown) {
      this.banner.style.display = bannerShown ? 'block' : 'none';
      this.lastBannerShown = bannerShown;
    }
    if (!bannerShown) return;

    let text: string;
    let color: string;

    if (round === null || round.phase === 'lobby') {
      text = 'Ready up to begin';
      color = SLATE;
    } else if (round.phase === 'countdown') {
      text = 'Get ready…';
      color = AMBER;
    } else if (round.phase === 'active') {
      if (team === 'human') {
        text = `Survive ${formatClock(round.timeLeftMs)}`;
        color = GREEN;
      } else if (team === 'zombie') {
        text = 'Infect the survivors';
        color = RED;
      } else {
        // Spectating / pre-spawn: neutral survive clock, no team allegiance.
        text = `Survive ${formatClock(round.timeLeftMs)}`;
        color = SLATE;
      }
    } else {
      // ended — reflect the result, mirroring the HUD's win/lose banner.
      if (round.winner === 'human') {
        text = 'Humans survived';
        color = GREEN;
      } else if (round.winner === 'zombie') {
        text = 'The horde wins';
        color = RED;
      } else {
        text = 'Round over';
        color = SLATE;
      }
    }

    if (text !== this.lastObjText) {
      this.banner.textContent = text;
      this.lastObjText = text;
    }
    if (color !== this.lastObjColor) {
      this.banner.style.color = color;
      this.lastObjColor = color;
    }
  }

  /* ---- Master switch + teardown ---------------------------------------- */

  /**
   * Master visibility toggle used by integration as a single switch: `false`
   * hides BOTH the crosshair and the objective banner outright, regardless of
   * play state; `true` returns them to their normal, state-driven visibility.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  /** Remove both overlays from the container. Idempotent. */
  dispose(): void {
    this.crossRoot.remove();
    this.banner.remove();
  }
}
