/**
 * The Crawling Dark — title / start overlay (M16 · t16a).
 *
 * `TitleScreen` is the full-screen "press Play to begin" overlay shown on first
 * load, before the player enters the world. Unlike the click-through HUD it
 * covers the whole viewport and opts back into pointer events, so it also doubles
 * as a gate that keeps the scene behind it until the player commits. It is styled
 * to match the HUD / options-menu idioms — dark, translucent, monospace, blurred
 * — with a big title, a one-line premise, a prominent green Play button, and a
 * compact controls hint.
 *
 * The whole element tree is built ONCE in the constructor and appended to the
 * container; the overlay starts **visible**. Its API is deliberately tiny:
 *
 *   - {@link show} / {@link hide} — flip the overlay's `display` (hide → none);
 *   - {@link visible} — a getter for the current visibility;
 *   - {@link dispose} — detach the overlay + its key listener (idempotent).
 *
 * Clicking Play — or pressing Enter / Space while the overlay is visible
 * (auto-repeat ignored) — hides the overlay and invokes the `onPlay` callback
 * passed to the constructor. The key listener is only live while the overlay is
 * shown, and is dropped on {@link hide} / {@link dispose} so it never fires
 * behind the world.
 *
 * Usage note: integration (t16e) constructs this with an `onPlay` that requests
 * pointer lock, handing control of the mouse to the renderer as the player drops
 * into the scene.
 */

/* -------------------------------------------------------------------------- */
/* Palette (mirrors the HUD / SettingsMenu look)                              */
/* -------------------------------------------------------------------------- */

/** Hopeful green — the title glow + the Play button accent. */
const GREEN = '#53ffa8';
/** Calm slate — the resting overlay text color. */
const SLATE = '#c8d6e5';
/** Muted slate — the premise + the controls hint line. */
const DIM = '#7f8c9a';

/** Shared monospace font stack, matching the HUD / options panels. */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/* -------------------------------------------------------------------------- */
/* TitleScreen                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The first-load title overlay. Construct once with the container to mount into
 * (the same `#app` div the renderer + HUD live in) and an `onPlay` callback;
 * drive with {@link show} / {@link hide} and {@link dispose} on teardown.
 */
export class TitleScreen {
  private readonly onPlay: () => void;

  /** The full-viewport overlay root; visibility is toggled via its `display`. */
  private readonly overlay: HTMLDivElement;
  private readonly playButton: HTMLButtonElement;

  private shown = false;

  constructor(container: HTMLElement, onPlay: () => void) {
    this.onPlay = onPlay;

    /* -- Full-viewport overlay shell (centered; starts visible) ----------- */
    // Covers the whole viewport and sits above the canvas. Unlike the HUD it
    // takes pointer events back so the Play button is clickable and the scene
    // behind it stays gated until the player commits.
    this.overlay = document.createElement('div');
    Object.assign(this.overlay.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '18px',
      font: `12px/1.5 ${MONO}`,
      color: SLATE,
      textAlign: 'center',
      background: 'rgba(5, 7, 10, 0.72)',
      backdropFilter: 'blur(4px)',
      // Interactive gate — take pointer events back from the click-through HUD.
      pointerEvents: 'auto',
      userSelect: 'none',
      // Sit above the canvas + HUD panels.
      zIndex: '50',
    } satisfies Partial<CSSStyleDeclaration>);

    /* -- Big title -------------------------------------------------------- */
    const title = document.createElement('div');
    title.textContent = 'The Crawling Dark';
    Object.assign(title.style, {
      font: `700 clamp(34px, 8vw, 64px)/1.05 ${MONO}`,
      letterSpacing: '0.04em',
      color: GREEN,
      textShadow: `0 0 24px ${GREEN}66`,
    } satisfies Partial<CSSStyleDeclaration>);

    /* -- One-line premise ------------------------------------------------- */
    const premise = document.createElement('div');
    premise.textContent = 'Survive the night. One of you is already infected.';
    Object.assign(premise.style, {
      fontSize: '15px',
      color: DIM,
      maxWidth: '38ch',
    } satisfies Partial<CSSStyleDeclaration>);

    /* -- Play button (green accent, subtle hover) ------------------------- */
    this.playButton = document.createElement('button');
    this.playButton.textContent = 'Play';
    Object.assign(this.playButton.style, {
      font: `700 18px/1.2 ${MONO}`,
      letterSpacing: '0.08em',
      color: GREEN,
      background: 'rgba(83, 255, 168, 0.12)',
      border: '1px solid rgba(83, 255, 168, 0.5)',
      borderRadius: '8px',
      padding: '12px 40px',
      marginTop: '8px',
      cursor: 'pointer',
      transition: 'background 120ms ease, box-shadow 120ms ease',
    } satisfies Partial<CSSStyleDeclaration>);
    this.playButton.addEventListener('mouseenter', () => {
      this.playButton.style.background = 'rgba(83, 255, 168, 0.22)';
      this.playButton.style.boxShadow = `0 0 20px ${GREEN}44`;
    });
    this.playButton.addEventListener('mouseleave', () => {
      this.playButton.style.background = 'rgba(83, 255, 168, 0.12)';
      this.playButton.style.boxShadow = 'none';
    });
    this.playButton.addEventListener('click', () => this.play());

    /* -- Controls hint ---------------------------------------------------- */
    const controls = document.createElement('div');
    controls.textContent =
      'WASD move · Shift run · Space jump · Click attack · Press H for controls';
    Object.assign(controls.style, {
      marginTop: '10px',
      fontSize: '12px',
      color: DIM,
    } satisfies Partial<CSSStyleDeclaration>);

    this.overlay.append(title, premise, this.playButton, controls);
    container.append(this.overlay);

    // Starts visible: mirror `shown` and arm the key listener.
    this.shown = true;
    window.addEventListener('keydown', this.onKey);
  }

  /* ---- Play (button + key) --------------------------------------------- */

  /**
   * Enter the world: hide the overlay, then invoke `onPlay`. Guarded so a stray
   * click / key after we've already hidden can't fire `onPlay` twice.
   */
  private play(): void {
    if (!this.shown) return;
    this.hide();
    this.onPlay();
  }

  /** `Enter` / `Space` (ignoring auto-repeat) starts the game while visible. */
  private readonly onKey = (ev: KeyboardEvent): void => {
    if (!this.shown || ev.repeat) return;
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    // Keep Space from also scrolling / triggering anything behind the overlay.
    ev.preventDefault();
    this.play();
  };

  /* ---- Show / hide ------------------------------------------------------ */

  /** Whether the overlay is currently visible. */
  get visible(): boolean {
    return this.shown;
  }

  /** Show the overlay and arm the Enter/Space listener. Idempotent. */
  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.overlay.style.display = 'flex';
    window.addEventListener('keydown', this.onKey);
  }

  /** Hide the overlay and drop the Enter/Space listener. Idempotent. */
  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.overlay.style.display = 'none';
    window.removeEventListener('keydown', this.onKey);
  }

  /* ---- Teardown --------------------------------------------------------- */

  /** Detach the overlay and its window listener. Idempotent. */
  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.overlay.remove();
  }
}
