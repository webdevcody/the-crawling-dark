/**
 * The Crawling Dark — pause / in-game menu overlay (M16 · t16c).
 *
 * `PauseMenu` is a centered modal panel that turns the once-silent `Esc` into a
 * real pause menu. It is styled to match the {@link SettingsMenu} idiom — dark,
 * translucent, monospace, blurred — and, like it, opts back into pointer events
 * so its buttons are clickable, sitting at a high `zIndex` above the HUD, the
 * help overlay, and the options menu.
 *
 * The intended pointer-lock flow (wired up by the t16e integration, NOT here):
 *   - Pressing `Esc` in play releases pointer lock, and integration {@link open}s
 *     this menu.
 *   - **Resume** → integration re-requests pointer lock and returns to play.
 *   - **Controls** → integration opens the help / controls overlay.
 *   - **Settings** → integration opens the options menu.
 *
 * To stay decoupled the panel is **purely callback-driven**: it imports no
 * {@link Controls}, {@link SettingsMenu}, help overlay, or other UI/system
 * module. Each button — and the `Escape` key, which mirrors Resume — simply
 * invokes one of the `actions` supplied to the constructor; the real behavior
 * lives on the other side of those callbacks.
 *
 * The whole element tree is built ONCE in the constructor. Opening only flips
 * the panel's `display` and arms an `Escape` key listener (auto-repeat ignored);
 * `Escape` runs the same path as Resume — {@link close} then `onResume`. Hidden
 * by default. Call {@link dispose} on teardown to detach the panel and its
 * window listener.
 */

/* -------------------------------------------------------------------------- */
/* Palette (mirrors the HUD / SettingsMenu look)                              */
/* -------------------------------------------------------------------------- */

/** Hopeful green — the primary "Resume" accent. */
const GREEN = '#53ffa8';
/** Calm slate — the resting button / body text color. */
const SLATE = '#c8d6e5';
/** Muted slate — the heading's supporting hint line. */
const DIM = '#7f8c9a';

/* -------------------------------------------------------------------------- */
/* PauseMenu                                                                  */
/* -------------------------------------------------------------------------- */

/** The set of integration hooks the menu fires; supplied by t16e. */
export interface PauseMenuActions {
  /** Resume play — integration re-requests pointer lock. Also fired by `Esc`. */
  onResume: () => void;
  /** Open the controls / help overlay. */
  onControls: () => void;
  /** Open the options menu. */
  onSettings: () => void;
}

/**
 * The centered pause modal. Construct once with the container to mount into
 * (the same `#app` div the renderer + HUD live in) and the integration
 * {@link PauseMenuActions}; drive with {@link open} / {@link close} /
 * {@link toggle}, and {@link dispose} on teardown.
 */
export class PauseMenu {
  private readonly container: HTMLElement;
  private readonly actions: PauseMenuActions;

  private readonly panel: HTMLDivElement;

  private opened = false;

  constructor(container: HTMLElement, actions: PauseMenuActions) {
    this.container = container;
    this.actions = actions;

    /* -- Panel shell (centered modal; hidden until open) ------------------ */
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      padding: '20px 24px',
      font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: SLATE,
      background: 'rgba(5, 7, 10, 0.9)',
      border: '1px solid rgba(58, 90, 106, 0.5)',
      borderRadius: '8px',
      // Unlike the HUD, this panel is interactive — take pointer events back.
      pointerEvents: 'auto',
      userSelect: 'none',
      backdropFilter: 'blur(3px)',
      // Hidden by default; open() flips this to 'flex'.
      display: 'none',
      flexDirection: 'column',
      gap: '12px',
      minWidth: '240px',
      textAlign: 'center',
      // Above the HUD, the help overlay, and the options menu.
      zIndex: '49',
    } satisfies Partial<CSSStyleDeclaration>);

    /* -- Heading + hint --------------------------------------------------- */
    const title = document.createElement('div');
    title.textContent = 'Paused';
    Object.assign(title.style, {
      font: '700 20px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.04em',
    } satisfies Partial<CSSStyleDeclaration>);

    const hint = document.createElement('div');
    hint.textContent = 'Esc to resume';
    Object.assign(hint.style, {
      color: DIM,
      marginBottom: '4px',
    } satisfies Partial<CSSStyleDeclaration>);

    this.panel.append(title, hint);

    /* -- Buttons (full-width, stacked) ------------------------------------ */
    // Resume — accented green; closes the menu, then hands back to integration.
    const resume = PauseMenu.makeButton('Resume', true);
    resume.addEventListener('click', () => this.resume());

    // Controls — close first, then let integration open the help overlay.
    const controls = PauseMenu.makeButton('Controls', false);
    controls.addEventListener('click', () => {
      this.close();
      this.actions.onControls();
    });

    // Settings — let integration open the options menu.
    const settings = PauseMenu.makeButton('Settings', false);
    settings.addEventListener('click', () => this.actions.onSettings());

    this.panel.append(resume, controls, settings);

    this.container.append(this.panel);
  }

  /* ---- Construction helpers -------------------------------------------- */

  /**
   * A full-width stacked button, styled like SettingsMenu's controls. `accent`
   * paints it in the "Resume" green; others rest in neutral slate.
   */
  private static makeButton(label: string, accent: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    const idleBorder = accent
      ? 'rgba(83, 255, 168, 0.5)'
      : 'rgba(58, 90, 106, 0.6)';
    const idleBg = accent ? 'rgba(83, 255, 168, 0.12)' : 'rgba(58, 90, 106, 0.2)';
    Object.assign(btn.style, {
      font: 'inherit',
      color: accent ? GREEN : SLATE,
      background: idleBg,
      border: `1px solid ${idleBorder}`,
      borderRadius: '4px',
      padding: '8px 12px',
      width: '100%',
      cursor: 'pointer',
      transition: 'background 0.1s ease, border-color 0.1s ease',
    } satisfies Partial<CSSStyleDeclaration>);
    // Subtle hover state.
    const hoverBg = accent
      ? 'rgba(83, 255, 168, 0.22)'
      : 'rgba(58, 90, 106, 0.35)';
    btn.addEventListener('mouseenter', () => {
      btn.style.background = hoverBg;
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = idleBg;
    });
    return btn;
  }

  /* ---- Open / close ----------------------------------------------------- */

  /** Whether the panel is currently visible. */
  get visible(): boolean {
    return this.opened;
  }

  /** Show the panel and arm the Esc listener. Idempotent. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.panel.style.display = 'flex';
    window.addEventListener('keydown', this.onKey);
  }

  /** Hide the panel and drop the Esc listener. Idempotent. */
  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.panel.style.display = 'none';
    window.removeEventListener('keydown', this.onKey);
  }

  /** Open when closed, close when open. */
  toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  /* ---- Actions ---------------------------------------------------------- */

  /** Close the menu, then hand control back to integration to resume play. */
  private resume(): void {
    this.close();
    this.actions.onResume();
  }

  /** `Escape` (ignoring auto-repeat) mirrors Resume while the panel is open. */
  private readonly onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || ev.repeat) return;
    ev.preventDefault();
    this.resume();
  };

  /* ---- Teardown --------------------------------------------------------- */

  /** Detach the panel and the window listener. Idempotent. */
  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.panel.remove();
  }
}
