/**
 * The Crawling Dark — controls-reference overlay (M16 · t16b).
 *
 * `HelpOverlay` is a centered modal that renders the canonical
 * {@link KEYBINDINGS} list as a quick controls reference: rows grouped under
 * Movement / Combat / Interface headings, each a styled key chip beside its
 * action. It is styled to match the HUD / {@link SettingsMenu} idiom — dark,
 * translucent, monospace, blurred — and, like the settings modal, opts back into
 * pointer events and rides a high `zIndex` so it sits above every HUD element.
 *
 * The overlay is a **read-only view** over the keybinding list: it builds its
 * whole element tree ONCE in the constructor from {@link KEYBINDINGS} and never
 * mutates game state. Opening only flips the panel's `display` and arms a
 * `keydown` listener; while open, `Escape`, `H`, or `?` (auto-repeat ignored)
 * close it, matching the keys that open it. Hidden by default.
 *
 * Wiring `H`/`?` to {@link toggle} it — and closing it from the pause menu — is
 * the integration task (t16e); this module owns only the panel and its own
 * close-key listener. Call {@link dispose} on teardown to detach the panel and
 * that listener; it is idempotent.
 */

import {
  KEYBINDINGS,
  KEYBINDING_GROUPS,
  type KeybindingGroup,
} from './keybindings';

/* -------------------------------------------------------------------------- */
/* Palette (mirrors the HUD / SettingsMenu look)                              */
/* -------------------------------------------------------------------------- */

/** Hopeful green — the title accent. */
const GREEN = '#53ffa8';
/** Calm slate — the resting panel text (actions + chip labels). */
const SLATE = '#c8d6e5';
/** Muted slate — group headings and the close hint. */
const DIM = '#7f8c9a';
/** Energetic amber — reserved accent, kept in step with the shared palette. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const AMBER = '#ffd24a';

/* -------------------------------------------------------------------------- */
/* HelpOverlay                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The centered controls-reference modal. Construct once with the container to
 * mount into (the same `#app` div the renderer + HUD live in); drive with
 * {@link open} / {@link close} / {@link toggle}, read {@link visible}, and call
 * {@link dispose} on teardown.
 */
export class HelpOverlay {
  private readonly panel: HTMLDivElement;

  private opened = false;
  /** Guards {@link dispose} so a double teardown is a no-op. */
  private disposed = false;

  constructor(container: HTMLElement) {
    /* -- Panel shell (centered modal; hidden until open) ------------------ */
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      padding: '18px 22px',
      font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: SLATE,
      background: 'rgba(5, 7, 10, 0.9)',
      border: '1px solid rgba(58, 90, 106, 0.5)',
      borderRadius: '8px',
      // Unlike the click-through HUD, this panel is interactive — take pointer
      // events back so it can't be clicked past while it's up.
      pointerEvents: 'auto',
      userSelect: 'none',
      backdropFilter: 'blur(3px)',
      // Hidden by default; open() flips this to 'flex'.
      display: 'none',
      flexDirection: 'column',
      gap: '12px',
      minWidth: '320px',
      // Sit above the settings menu (zIndex 20) and every HUD element.
      zIndex: '48',
    } satisfies Partial<CSSStyleDeclaration>);

    /* -- Title + hint ----------------------------------------------------- */
    const title = document.createElement('div');
    title.textContent = 'Controls';
    Object.assign(title.style, {
      font: '700 18px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.04em',
      color: GREEN,
    } satisfies Partial<CSSStyleDeclaration>);

    const hint = document.createElement('div');
    hint.textContent = 'H · ? · Esc to close';
    hint.style.color = DIM;

    this.panel.append(title, hint);

    /* -- Groups + rows, built once from KEYBINDINGS ----------------------- */
    for (const group of KEYBINDING_GROUPS) {
      const rows = KEYBINDINGS.filter((b) => b.group === group);
      if (rows.length === 0) continue;

      const heading = document.createElement('div');
      heading.textContent = group;
      Object.assign(heading.style, {
        marginTop: '4px',
        color: DIM,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        fontSize: '11px',
      } satisfies Partial<CSSStyleDeclaration>);

      const list = document.createElement('div');
      Object.assign(list.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      } satisfies Partial<CSSStyleDeclaration>);

      for (const binding of rows) list.append(HelpOverlay.makeRow(binding.key, binding.action));

      this.panel.append(heading, list);
    }

    container.append(this.panel);
  }

  /* ---- Construction helpers -------------------------------------------- */

  /** A "key chip + action" row: a bordered chip on the left, action text right. */
  private static makeRow(key: string, action: string): HTMLDivElement {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
    } satisfies Partial<CSSStyleDeclaration>);

    const chip = document.createElement('span');
    chip.textContent = key;
    Object.assign(chip.style, {
      display: 'inline-block',
      minWidth: '9ch',
      textAlign: 'center',
      color: SLATE,
      background: 'rgba(58, 90, 106, 0.2)',
      border: '1px solid rgba(58, 90, 106, 0.6)',
      borderRadius: '4px',
      padding: '2px 8px',
      whiteSpace: 'nowrap',
    } satisfies Partial<CSSStyleDeclaration>);

    const label = document.createElement('span');
    label.textContent = action;
    label.style.color = DIM;

    row.append(chip, label);
    return row;
  }

  /* ---- Open / close ----------------------------------------------------- */

  /** Whether the overlay is currently visible. */
  get visible(): boolean {
    return this.opened;
  }

  /** Show the overlay and arm the close-key listener. Idempotent. */
  open(): void {
    if (this.opened || this.disposed) return;
    this.opened = true;
    this.panel.style.display = 'flex';
    window.addEventListener('keydown', this.onKey);
  }

  /** Hide the overlay and drop the close-key listener. Idempotent. */
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

  /**
   * While open, `Escape`, `H`, or `?` close the overlay — the same keys that
   * toggle it (integration t16e). Auto-repeat is ignored so a held key can't
   * strobe the panel.
   */
  private readonly onKey = (ev: KeyboardEvent): void => {
    if (ev.repeat) return;
    const k = ev.key;
    if (k === 'Escape' || k === 'h' || k === 'H' || k === '?') this.close();
  };

  /* ---- Teardown --------------------------------------------------------- */

  /** Detach the panel and the window listener. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKey);
    this.opened = false;
    this.panel.remove();
  }
}
