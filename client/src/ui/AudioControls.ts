/**
 * The Crawling Dark — audio control overlay (M6 · t6d).
 *
 * A tiny, non-intrusive panel pinned to the bottom-right that drives the
 * {@link AudioEngine}: a mute toggle (also bound to the `M` key) plus master,
 * SFX, and music volume sliders. It is styled to match the HUD / turn-feed idioms — dark,
 * translucent, monospace, blurred — but, unlike those click-through overlays, it
 * opts back into pointer events so its controls are actually usable.
 *
 * Any interaction with the panel (or the `M` key) is a user gesture, so it also
 * nudges {@link AudioEngine.resume} + {@link AudioEngine.startAmbient}: the very
 * first person who reaches for the volume gets audio, even if they never clicked
 * the canvas.
 *
 * The element tree is built once in the constructor; the only per-interaction
 * mutation is the mute button's glyph/label. Call {@link dispose} on teardown to
 * detach the panel and the window key listener.
 */

import type { AudioEngine } from '../audio/AudioEngine';

/** Resting text color, matching the HUD's calm slate. */
const SLATE = '#c8d6e5';
/** Muted secondary color, matching the HUD's dim slate. */
const DIM = '#7f8c9a';
/** Accent used for the "live" (unmuted) speaker glyph. */
const GREEN = '#53ffa8';
/** Accent used for the muted state. */
const RED = '#ff6b6b';

/**
 * The bottom-right audio panel. Construct once with the container to mount into
 * (the same `#app` div the renderer + HUD live in) and the {@link AudioEngine}
 * to drive; call {@link dispose} on teardown.
 */
export class AudioControls {
  private readonly container: HTMLElement;
  private readonly engine: AudioEngine;

  private readonly panel: HTMLDivElement;
  private readonly muteButton: HTMLButtonElement;

  constructor(container: HTMLElement, engine: AudioEngine) {
    this.container = container;
    this.engine = engine;

    /* -- Panel shell (mirrors the HUD/feed overlay look) ------------------ */
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed',
      bottom: '12px',
      right: '12px',
      padding: '8px 12px',
      font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: SLATE,
      background: 'rgba(5, 7, 10, 0.72)',
      border: '1px solid rgba(58, 90, 106, 0.5)',
      borderRadius: '6px',
      // Unlike the HUD, this panel is interactive — take pointer events back.
      pointerEvents: 'auto',
      userSelect: 'none',
      backdropFilter: 'blur(2px)',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      minWidth: '168px',
    } satisfies Partial<CSSStyleDeclaration>);

    /* -- Header: mute button + "M: mute" hint ----------------------------- */
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '10px',
    } satisfies Partial<CSSStyleDeclaration>);

    this.muteButton = document.createElement('button');
    Object.assign(this.muteButton.style, {
      font: 'inherit',
      color: 'inherit',
      background: 'rgba(58, 90, 106, 0.2)',
      border: '1px solid rgba(58, 90, 106, 0.6)',
      borderRadius: '4px',
      padding: '2px 8px',
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>);
    this.muteButton.addEventListener('click', this.onToggle);

    const hint = document.createElement('span');
    hint.textContent = 'M: mute';
    hint.style.color = DIM;

    header.append(this.muteButton, hint);
    this.panel.append(header);

    /* -- Volume sliders --------------------------------------------------- */
    this.panel.append(
      this.makeSlider('master', engine.masterVolume, (v) => engine.setMasterVolume(v)),
      this.makeSlider('sfx', engine.sfxVolume, (v) => engine.setSfxVolume(v)),
      // M12 · t12c: the dynamic-intensity music bed gets its own independent fader.
      this.makeSlider('music', engine.musicVolume, (v) => engine.setMusicVolume(v)),
    );

    this.container.append(this.panel);
    this.refreshMute();

    // `M` toggles mute from anywhere (like `R` readies up on the window).
    window.addEventListener('keydown', this.onKey);
  }

  /**
   * Build one labeled `0..100` range slider. `onChange` receives a normalized
   * `0..1` value; interacting with it also resumes audio (a user gesture).
   */
  private makeSlider(
    label: string,
    initial: number,
    onChange: (v: number) => void,
  ): HTMLDivElement {
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
      width: '6ch',
      color: DIM,
    } satisfies Partial<CSSStyleDeclaration>);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = String(Math.round(initial * 100));
    slider.style.flex = '1';
    slider.style.cursor = 'pointer';
    slider.addEventListener('input', () => {
      this.engine.resume();
      this.engine.startAmbient();
      this.engine.startMusic();
      onChange(Number(slider.value) / 100);
    });

    row.append(name, slider);
    return row;
  }

  /** Toggle mute (and ensure audio is running so the change is audible). */
  private readonly onToggle = (): void => {
    this.engine.resume();
    this.engine.startAmbient();
    this.engine.startMusic();
    this.engine.toggleMute();
    this.refreshMute();
  };

  /** `M` (ignoring auto-repeat) mirrors the mute button. */
  private readonly onKey = (ev: KeyboardEvent): void => {
    if (ev.code !== 'KeyM' || ev.repeat) return;
    this.onToggle();
  };

  /** Repaint the mute button's glyph + accent from the engine's mute state. */
  private refreshMute(): void {
    const muted = this.engine.muted;
    this.muteButton.textContent = muted ? '🔇 muted' : '🔊 sound';
    this.muteButton.style.color = muted ? RED : GREEN;
    this.muteButton.style.borderColor = muted
      ? 'rgba(255, 107, 107, 0.6)'
      : 'rgba(83, 255, 168, 0.5)';
  }

  /** Detach the panel + window listener. Idempotent. */
  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.panel.remove();
  }
}
