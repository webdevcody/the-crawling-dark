/**
 * The Crawling Dark — options menu overlay (M15 · t15c).
 *
 * `SettingsMenu` is a centered modal panel that edits a {@link Settings} store:
 * a post-processing toggle, a minimap toggle, a reduced-motion toggle, a
 * mouse-sensitivity slider, and a three-way render-quality selector. It is
 * styled to match the HUD / audio-panel idioms — dark, translucent, monospace,
 * blurred — but, like {@link AudioControls} and unlike the click-through HUD, it
 * opts back into pointer events so its controls are usable.
 *
 * The menu is a **thin, two-way-bound view** over the store and nothing more:
 * every control reflects the current preference when the panel opens, and writing
 * a control calls {@link Settings.set}. It does **not** touch the renderer, the
 * minimap, or {@link Controls} — turning these preferences into real behavior is
 * a separate integration task. Because it also {@link Settings.subscribe}s, a
 * change made anywhere else (e.g. a future keybind) is reflected here too.
 *
 * The whole element tree is built ONCE in the constructor; opening only flips the
 * panel's `display`, refreshes the controls from the store, and arms an `Escape`
 * key listener (auto-repeat ignored). Hidden by default. Call {@link dispose} on
 * teardown to detach the panel, its window listener, and the store subscription.
 */

import {
  Settings,
  MOUSE_SENSITIVITY_MIN,
  MOUSE_SENSITIVITY_MAX,
  RENDER_QUALITIES,
  type RenderQuality,
} from './Settings';

/* -------------------------------------------------------------------------- */
/* Palette (mirrors the HUD / AudioControls look)                             */
/* -------------------------------------------------------------------------- */

/** Hopeful green — an "on" toggle / the selected quality. */
const GREEN = '#53ffa8';
/** Ominous red — reserved accent, kept in step with the shared palette. */
const RED = '#ff6b6b';
/** Energetic amber — the live numeric sensitivity readout. */
const AMBER = '#ffd24a';
/** Calm slate — the resting panel text color. */
const SLATE = '#c8d6e5';
/** Muted slate — labels, the hint line, and "off" states. */
const DIM = '#7f8c9a';

/** Step for the sensitivity slider — 4 decimals across the [min, max] band. */
const SENSITIVITY_STEP = 0.0001;

/* -------------------------------------------------------------------------- */
/* SettingsMenu                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The centered options modal. Construct once with the container to mount into
 * (the same `#app` div the renderer + HUD live in) and the {@link Settings}
 * store to edit; drive with {@link open} / {@link close} / {@link toggle}, and
 * {@link dispose} on teardown.
 */
export class SettingsMenu {
  private readonly container: HTMLElement;
  private readonly settings: Settings;

  private readonly panel: HTMLDivElement;
  private readonly postButton: HTMLButtonElement;
  private readonly minimapButton: HTMLButtonElement;
  private readonly reducedMotionButton: HTMLButtonElement;
  private readonly sensSlider: HTMLInputElement;
  private readonly sensValue: HTMLSpanElement;
  /** One button per {@link RenderQuality}, keyed for the active-state repaint. */
  private readonly qualityButtons = new Map<RenderQuality, HTMLButtonElement>();

  /** Live subscription to the store, so external writes reflect here too. */
  private readonly unsubscribe: () => void;

  private opened = false;

  constructor(container: HTMLElement, settings: Settings) {
    this.container = container;
    this.settings = settings;

    /* -- Panel shell (centered modal; hidden until open) ------------------ */
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      padding: '16px 20px',
      font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: SLATE,
      background: 'rgba(5, 7, 10, 0.72)',
      border: '1px solid rgba(58, 90, 106, 0.5)',
      borderRadius: '8px',
      // Unlike the HUD, this panel is interactive — take pointer events back.
      pointerEvents: 'auto',
      userSelect: 'none',
      backdropFilter: 'blur(2px)',
      // Hidden by default; open() flips this to 'flex'.
      display: 'none',
      flexDirection: 'column',
      gap: '10px',
      minWidth: '300px',
      zIndex: '20',
    } satisfies Partial<CSSStyleDeclaration>);

    /* -- Title + hint ----------------------------------------------------- */
    const title = document.createElement('div');
    title.textContent = 'OPTIONS';
    Object.assign(title.style, {
      font: '700 18px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.04em',
    } satisfies Partial<CSSStyleDeclaration>);

    const hint = document.createElement('div');
    hint.textContent = 'client preferences · Esc to close';
    hint.style.color = DIM;

    this.panel.append(title, hint);

    /* -- Controls (each two-way bound to the store) ----------------------- */
    // Post-processing toggle — styled like AudioControls' mute button.
    this.postButton = SettingsMenu.makeButton();
    this.postButton.addEventListener('click', () => {
      this.settings.set('postProcessing', !this.settings.get('postProcessing'));
    });

    // Minimap toggle.
    this.minimapButton = SettingsMenu.makeButton();
    this.minimapButton.addEventListener('click', () => {
      this.settings.set('minimap', !this.settings.get('minimap'));
    });

    // Reduced-motion toggle — suppresses non-essential UI animations.
    this.reducedMotionButton = SettingsMenu.makeButton();
    this.reducedMotionButton.addEventListener('click', () => {
      this.settings.set('reducedMotion', !this.settings.get('reducedMotion'));
    });

    // Mouse sensitivity — a range over [MIN, MAX] with a live numeric readout.
    this.sensSlider = document.createElement('input');
    this.sensSlider.type = 'range';
    this.sensSlider.min = String(MOUSE_SENSITIVITY_MIN);
    this.sensSlider.max = String(MOUSE_SENSITIVITY_MAX);
    this.sensSlider.step = String(SENSITIVITY_STEP);
    this.sensSlider.style.flex = '1';
    this.sensSlider.style.cursor = 'pointer';
    this.sensSlider.addEventListener('input', () => {
      this.settings.set('mouseSensitivity', Number(this.sensSlider.value));
    });
    this.sensValue = document.createElement('span');
    Object.assign(this.sensValue.style, {
      display: 'inline-block',
      width: '7ch',
      textAlign: 'right',
      color: AMBER,
    } satisfies Partial<CSSStyleDeclaration>);
    const sensGroup = document.createElement('div');
    Object.assign(sensGroup.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      flex: '1',
    } satisfies Partial<CSSStyleDeclaration>);
    sensGroup.append(this.sensSlider, this.sensValue);

    // Render quality — three mutually-exclusive buttons.
    const qualityGroup = document.createElement('div');
    Object.assign(qualityGroup.style, {
      display: 'flex',
      gap: '6px',
      flex: '1',
    } satisfies Partial<CSSStyleDeclaration>);
    for (const quality of RENDER_QUALITIES) {
      const btn = SettingsMenu.makeButton();
      btn.textContent = quality;
      btn.style.flex = '1';
      btn.addEventListener('click', () => {
        this.settings.set('renderQuality', quality);
      });
      this.qualityButtons.set(quality, btn);
      qualityGroup.append(btn);
    }

    this.panel.append(
      SettingsMenu.makeRow('post-fx', this.postButton),
      SettingsMenu.makeRow('minimap', this.minimapButton),
      SettingsMenu.makeRow('reduced', this.reducedMotionButton),
      SettingsMenu.makeRow('mouse', sensGroup),
      SettingsMenu.makeRow('quality', qualityGroup),
    );

    /* -- Footer: Close button --------------------------------------------- */
    const footer = document.createElement('div');
    Object.assign(footer.style, {
      display: 'flex',
      justifyContent: 'flex-end',
      marginTop: '4px',
    } satisfies Partial<CSSStyleDeclaration>);
    const closeButton = SettingsMenu.makeButton();
    closeButton.textContent = 'close';
    closeButton.addEventListener('click', () => this.close());
    footer.append(closeButton);
    this.panel.append(footer);

    this.container.append(this.panel);

    // Reflect external writes (and our own) back into the controls.
    this.unsubscribe = this.settings.subscribe(() => this.refresh());
    this.refresh();
  }

  /* ---- Construction helpers -------------------------------------------- */

  /** A button styled like AudioControls' mute button. */
  private static makeButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    Object.assign(btn.style, {
      font: 'inherit',
      color: 'inherit',
      background: 'rgba(58, 90, 106, 0.2)',
      border: '1px solid rgba(58, 90, 106, 0.6)',
      borderRadius: '4px',
      padding: '2px 8px',
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>);
    return btn;
  }

  /** A "label + control" row with a fixed-width label column, like the sliders. */
  private static makeRow(label: string, control: HTMLElement): HTMLDivElement {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    } satisfies Partial<CSSStyleDeclaration>);

    const name = document.createElement('span');
    name.textContent = label;
    Object.assign(name.style, {
      display: 'inline-block',
      width: '8ch',
      color: DIM,
    } satisfies Partial<CSSStyleDeclaration>);

    row.append(name, control);
    return row;
  }

  /* ---- Two-way binding -------------------------------------------------- */

  /** Repaint every control from the current store state. */
  private refresh(): void {
    const state = this.settings.getAll();
    SettingsMenu.paintToggle(this.postButton, state.postProcessing);
    SettingsMenu.paintToggle(this.minimapButton, state.minimap);
    SettingsMenu.paintToggle(this.reducedMotionButton, state.reducedMotion);
    this.sensSlider.value = String(state.mouseSensitivity);
    this.sensValue.textContent = state.mouseSensitivity.toFixed(4);
    for (const [quality, btn] of this.qualityButtons) {
      SettingsMenu.paintSelected(btn, quality === state.renderQuality);
    }
  }

  /** Paint a boolean toggle button: green "on" / dim "off", like the mute glyph. */
  private static paintToggle(btn: HTMLButtonElement, on: boolean): void {
    btn.textContent = on ? 'on' : 'off';
    SettingsMenu.paintSelected(btn, on);
  }

  /** Accent a button when it is the active choice; neutral otherwise. */
  private static paintSelected(btn: HTMLButtonElement, selected: boolean): void {
    btn.style.color = selected ? GREEN : DIM;
    btn.style.borderColor = selected
      ? 'rgba(83, 255, 168, 0.5)'
      : 'rgba(58, 90, 106, 0.6)';
    btn.style.background = selected
      ? 'rgba(83, 255, 168, 0.12)'
      : 'rgba(58, 90, 106, 0.2)';
  }

  /* ---- Open / close ----------------------------------------------------- */

  /** Whether the panel is currently visible. */
  get isOpen(): boolean {
    return this.opened;
  }

  /** Show the panel, sync its controls to the store, and arm the Esc listener. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.refresh();
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

  /** `Escape` (ignoring auto-repeat) closes the panel while it is open. */
  private readonly onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || ev.repeat) return;
    this.close();
  };

  /* ---- Teardown --------------------------------------------------------- */

  /** Detach the panel, the window listener, and the store subscription. Idempotent. */
  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.unsubscribe();
    this.panel.remove();
  }
}
