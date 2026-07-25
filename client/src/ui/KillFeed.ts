/**
 * The Crawling Dark — kill / turn feed overlay (M16 · t16d).
 *
 * `KillFeed` is the small, self-expiring stack of recent combat lines pinned to
 * the bottom-left corner — "#3 stunned #7 🦇", "Player #4 was turned 🧟", and
 * the like. It is a fixed, click-through DOM piece it appends to a container
 * passed in the constructor (the same `#app` div the renderer, HUD, and
 * {@link Reticle} live in), extracted from the ad-hoc feed that used to live
 * inline in `main.ts`.
 *
 * It is deliberately protocol-agnostic: {@link push} takes an already-formatted
 * string, so nothing here knows about wire types or player identity — building
 * those "#x stunned #y" / "was turned" strings stays entirely with the caller.
 * Newest lines land on top, the stack is capped at {@link FEED_MAX_LINES} (the
 * oldest drop off), and each line counts its own {@link FEED_TTL_MS} down in
 * {@link update}, fading over its final second (opacity = `min(1, ttl/1000)`)
 * before it is spliced out; when the last line expires the whole root hides
 * itself again.
 *
 * The root is built ONCE in the constructor and hidden until the first line
 * lands. Each line keeps a cached node, so {@link update} only writes the handful
 * of `opacity` values that actually changed that frame (never rebuilding
 * `innerHTML`), and a freshly pushed line gets a cheap one-shot fade + slide-in.
 * Like the HUD and Reticle it is `pointer-events: none` / `user-select: none`,
 * sitting above the WebGL canvas without ever stealing clicks.
 *
 * Integration (t16e) removes the inline feed from `main.ts` and drives this
 * instead: {@link push} on each kill/turn event and {@link update} every frame.
 */

/* -------------------------------------------------------------------------- */
/* Behavior constants (match the original inline feed)                        */
/* -------------------------------------------------------------------------- */

/** How long a feed line stays up before it has fully faded, in ms. */
export const FEED_TTL_MS = 6000;

/** Cap on feed lines kept on screen (newest win, oldest drop off). */
export const FEED_MAX_LINES = 5;

/* -------------------------------------------------------------------------- */
/* Palette (mirrors the inline feed's dark, blood-red look)                   */
/* -------------------------------------------------------------------------- */

/** Pale rose — the resting line text color. */
const TEXT = '#e6d2d2';
/** Dark translucent panel fill. */
const PANEL_BG = 'rgba(5, 7, 10, 0.72)';
/** Faint blood-red panel border. */
const PANEL_BORDER = 'rgba(106, 58, 58, 0.5)';
/** Slightly brighter blood-red — the per-line left accent bar. */
const ACCENT = 'rgba(176, 90, 90, 0.85)';

/* -------------------------------------------------------------------------- */
/* Internal line record                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One feed line: its own countdown, the cached DOM node it renders into, and the
 * last opacity written so {@link KillFeed.update} can skip no-op DOM writes.
 * Newest are `unshift`ed to the top of {@link KillFeed.lines} (and `prepend`ed
 * to the root), so array order matches on-screen order top-to-bottom.
 */
interface FeedLine {
  ttl: number;
  readonly el: HTMLDivElement;
  lastAlpha: number;
}

/* -------------------------------------------------------------------------- */
/* KillFeed                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The bottom-left kill / turn feed. Construct it once with the container to mount
 * into (the same `#app` div the renderer lives in), {@link push} a pre-formatted
 * string on each kill/turn event, call {@link update} every render frame to age
 * lines out, and {@link dispose} on teardown.
 */
export class KillFeed {
  /** Fixed, click-through wrapper holding the stack of line nodes. Built once. */
  private readonly root: HTMLDivElement;
  /** Live lines, newest first (index 0 renders at the top). */
  private readonly lines: FeedLine[] = [];
  /** Last-written root visibility, so per-frame refreshes only touch it on a flip. */
  private lastShown: boolean | null = null;
  /** Guards against use after {@link dispose} (also makes dispose idempotent). */
  private disposed = false;
  /** When true, {@link push}'s one-shot enter animation is suppressed (M17 a11y). */
  private reducedMotion = false;

  constructor(container: HTMLElement) {
    // A compact, translucent, click-through stack pinned to the bottom-left —
    // matching the inline feed's placement and palette. Kept hidden until the
    // first line lands (see the `display: none` below), and flipped on/off by
    // {@link update} as lines come and go.
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'fixed',
      bottom: '12px',
      left: '12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
      padding: '8px 12px',
      font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: TEXT,
      background: PANEL_BG,
      border: `1px solid ${PANEL_BORDER}`,
      borderRadius: '6px',
      pointerEvents: 'none',
      userSelect: 'none',
      backdropFilter: 'blur(2px)',
      maxWidth: '320px',
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.style.display = 'none'; // hidden until the first event lands
    container.append(this.root);
  }

  /* ---- Events ----------------------------------------------------------- */

  /**
   * Push a new line onto the feed. The text is treated as opaque, pre-formatted
   * plain text (e.g. `"#3 stunned #7 🦇"`) — it is set via `textContent`, so no
   * markup is interpreted. The line lands on top with a full {@link FEED_TTL_MS}
   * countdown and a cheap one-shot fade + slide-in; the stack is then trimmed to
   * the newest {@link FEED_MAX_LINES}, dropping the oldest. The root reveals
   * itself on the next {@link update}.
   */
  push(text: string): void {
    if (this.disposed) return;

    const el = document.createElement('div');
    Object.assign(el.style, {
      paddingLeft: '8px',
      borderLeft: `2px solid ${ACCENT}`,
      whiteSpace: 'pre',
      opacity: '1',
    } satisfies Partial<CSSStyleDeclaration>);
    el.textContent = text;

    this.root.prepend(el);
    this.lines.unshift({ ttl: FEED_TTL_MS, el, lastAlpha: 1 });

    // Gentle, cheap enter: a one-shot fade + short slide from the left. Uses only
    // opacity + transform so it never fights the ttl-driven opacity we manage per
    // frame (which sits at 1 for a fresh line anyway). Guarded for environments
    // without the Web Animations API (e.g. jsdom in tests).
    if (!this.reducedMotion) {
      el.animate?.(
        [
          { opacity: 0, transform: 'translateX(-8px)' },
          { opacity: 1, transform: 'translateX(0)' },
        ],
        { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
      );
    }

    // Trim to the newest FEED_MAX_LINES, dropping (and detaching) the oldest.
    while (this.lines.length > FEED_MAX_LINES) {
      const dropped = this.lines.pop();
      dropped?.el.remove();
    }
  }

  /**
   * Toggle the one-shot enter animation off (or back on). Under reduced motion
   * {@link push} skips the fade/slide-in and new lines simply appear in place.
   */
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  /* ---- Per-frame update ------------------------------------------------- */

  /**
   * Age every line by `dtMs`, splice out any that have expired (detaching their
   * node), then refresh: hide the root outright when empty and show it otherwise,
   * and fade each surviving line by `opacity = min(1, ttl / 1000)` — full for its
   * first five seconds, then a smooth fade over its final second. Writes to the
   * DOM only where a value actually changed (visibility flips, and the handful of
   * opacities in flux), so a steady feed does no writes at all.
   */
  update(dtMs: number): void {
    if (this.disposed) return;

    // Count each line down and drop the expired ones (walk back-to-front so
    // splices don't shift indices we've yet to visit).
    for (let i = this.lines.length - 1; i >= 0; i -= 1) {
      const line = this.lines[i];
      line.ttl -= dtMs;
      if (line.ttl <= 0) {
        line.el.remove();
        this.lines.splice(i, 1);
      }
    }

    const shown = this.lines.length > 0;
    if (shown !== this.lastShown) {
      this.root.style.display = shown ? 'flex' : 'none';
      this.lastShown = shown;
    }
    if (!shown) return;

    // Fade each line over its last second; only write opacity when it moved.
    for (const line of this.lines) {
      const alpha = Math.min(1, line.ttl / 1000);
      if (Math.abs(alpha - line.lastAlpha) > 0.005) {
        line.el.style.opacity = alpha.toFixed(2);
        line.lastAlpha = alpha;
      }
    }
  }

  /* ---- Teardown --------------------------------------------------------- */

  /** Remove the feed root (and all its lines) from the container. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.remove();
    this.lines.length = 0;
  }
}
