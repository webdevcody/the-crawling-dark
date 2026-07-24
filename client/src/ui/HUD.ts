/**
 * The Crawling Dark — heads-up display (M5 · t5d).
 *
 * `HUD` is the self-contained on-screen overlay that surfaces the round loop so
 * a whole match reads at a glance: lobby -> countdown -> the 5:00 round -> a
 * win/lose banner -> back to lobby. It owns two fixed-position DOM panels it
 * appends to a container passed in the constructor:
 *
 *   - a **top-left status panel** — connection dot + title, your team, the live
 *     humans-alive / zombie score, tick, rtt, and the controls hints (including
 *     an `R: ready` hint that reflects your lobby ready state);
 *   - a **top-center round banner** — a big, phase-driven headline (the lobby
 *     ready gate, the countdown, the mm:ss round clock, or the results banner).
 *
 * Every value on screen is **driven by ROUND messages** (phase, timeLeftMs,
 * humansAlive, zombieCount, winner, readyCount, playerCount). Before the first
 * ROUND arrives — or after a disconnect clears it — the HUD degrades gracefully
 * to a "connecting / awaiting round" look with `—` placeholders instead of
 * crashing.
 *
 * The whole element tree is built ONCE in the constructor; {@link update} (called
 * once per render frame from the animate loop) only mutates `textContent`,
 * colors, and visibility on the cached nodes, so a running HUD never allocates
 * or re-parents DOM. It deliberately depends only on the DOM + shared wire types
 * (no Three.js), mirroring the render-agnostic split the rest of the client uses.
 */

import {
  MIN_PLAYERS_TO_START,
  STAMINA_MIN_TO_SPRINT,
  type EntityKind,
  type RoundMessage,
} from '@crawling-dark/shared';
import type { ConnectionStatus } from '../net/Connection';

/* -------------------------------------------------------------------------- */
/* Public state contract                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything {@link HUD.update} needs for one frame. Assembled by the render
 * loop from the {@link Connection} surface plus a little local state (the team
 * derived from the local entity's `kind`, and the local ready flag main tracks).
 */
export interface HudState {
  /** Latest ROUND frame, or `null` before the first one / after a disconnect. */
  round: RoundMessage | null;
  /** Coarse socket lifecycle, for the status dot + line. */
  status: ConnectionStatus;
  /** Our controlled entity id, or `null` before WELCOME. */
  playerId: number | null;
  /** Smoothed round-trip time in milliseconds (0 until the first PONG). */
  rttMs: number;
  /** Latest server simulation tick. */
  tick: number;
  /** The local player's team (from its entity `kind`), or `null` if not spawned. */
  team: EntityKind | null;
  /**
   * The local player's server-authoritative stamina fraction (0..1), or `null`
   * before we spawn / while spectating. The bar renders empty & neutral for
   * `null` and mirrors this value exactly otherwise.
   */
  stamina: number | null;
  /** Whether the local player has toggled ready in the lobby. */
  ready: boolean;
  /** Pointer-look hint string (reused from main's `lookHint` logic). */
  lookHint: string;
}

/* -------------------------------------------------------------------------- */
/* Palette + helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Hopeful green — humans survived, "open" status, your own highlight. */
const GREEN = '#53ffa8';
/** Ominous red — the horde wins, a dead/closed socket. */
const RED = '#ff6b6b';
/** Energetic amber — countdown / connecting. */
const AMBER = '#ffd24a';
/** Calm slate — the resting HUD text color. */
const SLATE = '#c8d6e5';
/** Muted slate — placeholders and secondary lines. */
const DIM = '#7f8c9a';

/** Color-tagged status dot, matching the old inline HUD's mapping. */
function statusColor(status: ConnectionStatus): string {
  switch (status) {
    case 'open':
      return GREEN;
    case 'connecting':
    case 'reconnecting':
      return AMBER;
    default:
      return RED;
  }
}

/**
 * Format a millisecond duration as `M:SS` (e.g. `247000` -> `4:07`). Uses `ceil`
 * so a fresh 5:00 round reads `5:00` and only hits `0:00` at the very end, and
 * clamps negatives to `0:00`. Shared by the round clock and the "returning in"
 * / countdown readouts (which want the same rounding).
 */
function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Whole seconds remaining (ceil, clamped), for the countdown + results copy. */
function secondsLeft(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

/* -------------------------------------------------------------------------- */
/* HUD                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The round-loop HUD overlay. Construct it once with the container to mount into
 * (the same `#app` div the renderer lives in), call {@link update} every frame,
 * and {@link dispose} on teardown.
 */
export class HUD {
  private readonly container: HTMLElement;

  /* ---- Status panel (top-left) ----------------------------------------- */
  private readonly panel: HTMLDivElement;
  private readonly statusDot: HTMLSpanElement;
  private readonly statusValue: HTMLSpanElement;
  private readonly playerIdValue: HTMLSpanElement;
  private readonly teamValue: HTMLSpanElement;
  private readonly humansValue: HTMLSpanElement;
  private readonly zombiesValue: HTMLSpanElement;
  private readonly tickValue: HTMLSpanElement;
  private readonly rttValue: HTMLSpanElement;
  /** Fixed-width stamina bar track; its {@link staminaFill} child shows the level. */
  private readonly staminaTrack: HTMLSpanElement;
  /** The stamina bar's fill — width follows the fraction, color flags "low". */
  private readonly staminaFill: HTMLSpanElement;
  private readonly readyHint: HTMLSpanElement;
  private readonly lookHint: HTMLSpanElement;

  /* ---- Round banner (top-center) --------------------------------------- */
  private readonly banner: HTMLDivElement;
  private readonly bannerTitle: HTMLDivElement;
  private readonly bannerLine1: HTMLDivElement;
  private readonly bannerLine2: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.container = container;

    /* -- Top-left status panel ------------------------------------------- */
    // Mirrors the old inline `hud` div: dark, monospace, translucent, click-
    // through, non-selectable, with a faint blur so it stays legible over the
    // scene without stealing pointer events from the canvas.
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed',
      top: '12px',
      left: '12px',
      padding: '10px 14px',
      font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: SLATE,
      background: 'rgba(5, 7, 10, 0.72)',
      border: '1px solid rgba(58, 90, 106, 0.5)',
      borderRadius: '6px',
      pointerEvents: 'none',
      userSelect: 'none',
      whiteSpace: 'pre',
      backdropFilter: 'blur(2px)',
    } satisfies Partial<CSSStyleDeclaration>);

    // Header: status dot + title.
    const header = document.createElement('div');
    this.statusDot = document.createElement('span');
    this.statusDot.textContent = '● ';
    const title = document.createElement('b');
    title.textContent = 'The Crawling Dark · M5';
    header.append(this.statusDot, title);
    this.panel.append(header);

    // Labeled value rows (label padded to a fixed column so values align).
    this.statusValue = this.addRow('status');
    this.playerIdValue = this.addRow('playerId');
    this.teamValue = this.addRow('team');
    // Humans + zombies share one row: "humans N    zombies N".
    const scoreRow = document.createElement('div');
    const humansLabel = HUD.makeLabel('humans');
    this.humansValue = document.createElement('span');
    const zombiesLabel = document.createElement('span');
    zombiesLabel.textContent = '    zombies ';
    this.zombiesValue = document.createElement('span');
    scoreRow.append(humansLabel, this.humansValue, zombiesLabel, this.zombiesValue);
    this.panel.append(scoreRow);
    this.tickValue = this.addRow('tick');
    this.rttValue = this.addRow('rtt');

    // Stamina bar row: a fixed-width track holding a fill whose width tracks the
    // authoritative stamina fraction. Built ONCE here; `update` only resizes and
    // recolors the fill, never re-parents anything.
    const staminaRow = document.createElement('div');
    this.staminaTrack = document.createElement('span');
    Object.assign(this.staminaTrack.style, {
      display: 'inline-block',
      verticalAlign: 'middle',
      width: '120px',
      height: '8px',
      background: 'rgba(58, 90, 106, 0.35)',
      border: '1px solid rgba(58, 90, 106, 0.6)',
      borderRadius: '4px',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    this.staminaFill = document.createElement('span');
    Object.assign(this.staminaFill.style, {
      display: 'block',
      height: '100%',
      width: '100%',
      background: GREEN,
      transition: 'width 80ms linear',
    } satisfies Partial<CSSStyleDeclaration>);
    this.staminaTrack.append(this.staminaFill);
    staminaRow.append(HUD.makeLabel('stamina'), this.staminaTrack);
    this.panel.append(staminaRow);

    this.addStatic('move', 'WASD · Shift run · C crawl · Space jump');
    this.addStatic('combat', 'Left-click: swing bat');
    this.readyHint = this.addRow('ready');
    // The look hint sits on its own full-width line (no label column), like the
    // old HUD's trailing hint.
    this.lookHint = document.createElement('span');
    const lookRow = document.createElement('div');
    lookRow.append(this.lookHint);
    this.panel.append(lookRow);

    this.container.append(this.panel);

    /* -- Top-center round banner ----------------------------------------- */
    // A prominent-but-tasteful headline pinned to the top-center: the big round
    // clock lives here during play (like a classic match timer) and the results
    // banner flashes here at the end, without covering the play view.
    this.banner = document.createElement('div');
    Object.assign(this.banner.style, {
      position: 'fixed',
      top: '7%',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '12px 24px',
      font: '13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      textAlign: 'center',
      color: SLATE,
      background: 'rgba(5, 7, 10, 0.72)',
      border: '1px solid rgba(58, 90, 106, 0.5)',
      borderRadius: '8px',
      pointerEvents: 'none',
      userSelect: 'none',
      backdropFilter: 'blur(2px)',
      minWidth: '260px',
    } satisfies Partial<CSSStyleDeclaration>);

    this.bannerTitle = document.createElement('div');
    Object.assign(this.bannerTitle.style, {
      font: '700 34px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.04em',
    } satisfies Partial<CSSStyleDeclaration>);

    this.bannerLine1 = document.createElement('div');
    Object.assign(this.bannerLine1.style, {
      marginTop: '6px',
      fontSize: '14px',
    } satisfies Partial<CSSStyleDeclaration>);

    this.bannerLine2 = document.createElement('div');
    Object.assign(this.bannerLine2.style, {
      marginTop: '2px',
      fontSize: '13px',
      color: DIM,
    } satisfies Partial<CSSStyleDeclaration>);

    this.banner.append(this.bannerTitle, this.bannerLine1, this.bannerLine2);
    this.container.append(this.banner);
  }

  /* ---- Construction helpers -------------------------------------------- */

  /** A fixed-width label span so monospace value columns line up. */
  private static makeLabel(text: string): HTMLSpanElement {
    const label = document.createElement('span');
    label.textContent = text;
    Object.assign(label.style, {
      display: 'inline-block',
      width: '9ch',
      color: DIM,
    } satisfies Partial<CSSStyleDeclaration>);
    return label;
  }

  /** Append a "label + value" row to the panel and return the value span. */
  private addRow(label: string): HTMLSpanElement {
    const row = document.createElement('div');
    const value = document.createElement('span');
    row.append(HUD.makeLabel(label), value);
    this.panel.append(row);
    return value;
  }

  /** Append a "label + constant value" row (no reference kept — never changes). */
  private addStatic(label: string, value: string): void {
    const row = document.createElement('div');
    const val = document.createElement('span');
    val.textContent = value;
    row.append(HUD.makeLabel(label), val);
    this.panel.append(row);
  }

  /* ---- Per-frame update ------------------------------------------------- */

  /**
   * Refresh both panels for one frame. Cheap: only text, colors, and the
   * banner's second line's visibility are touched — no nodes are created.
   */
  update(state: HudState): void {
    const { round } = state;

    /* -- Status panel ---------------------------------------------------- */
    this.statusDot.style.color = statusColor(state.status);
    this.statusValue.textContent = state.status;
    this.playerIdValue.textContent =
      state.playerId !== null ? String(state.playerId) : '—';
    this.teamValue.textContent = state.team ?? '—';
    // Counts come from ROUND (the authoritative score); `—` before it arrives.
    this.humansValue.textContent = round ? String(round.humansAlive) : '—';
    this.zombiesValue.textContent = round ? String(round.zombieCount) : '—';
    this.tickValue.textContent = String(state.tick);
    this.rttValue.textContent =
      state.rttMs > 0 ? `${Math.round(state.rttMs)} ms` : '—';

    // Stamina bar — mirror the authoritative fraction exactly: width = fraction,
    // amber while below the sprint-enable threshold (i.e. exhausted / recovering,
    // sprint locked out) and green once sprint is available again. With no local
    // stamina (pre-spawn / spectating) show an empty, neutral track.
    const { stamina } = state;
    if (stamina === null) {
      this.staminaFill.style.width = '0%';
      this.staminaFill.style.background = DIM;
    } else {
      const frac = Math.max(0, Math.min(1, stamina));
      this.staminaFill.style.width = `${frac * 100}%`;
      this.staminaFill.style.background = frac < STAMINA_MIN_TO_SPRINT ? AMBER : GREEN;
    }

    // `R: ready` hint — reflects your live ready state while in the lobby, and
    // reads as a plain hint the rest of the time (readiness only matters there).
    const inLobby = round?.phase === 'lobby';
    if (inLobby) {
      this.readyHint.textContent = state.ready
        ? 'R: ready ✔ (press to unready)'
        : 'R: press to ready up';
      this.readyHint.style.color = state.ready ? GREEN : SLATE;
    } else {
      this.readyHint.textContent = 'R: ready (lobby only)';
      this.readyHint.style.color = DIM;
    }

    this.lookHint.textContent = state.lookHint;

    /* -- Round banner ---------------------------------------------------- */
    this.updateBanner(state);
  }

  /**
   * Drive the top-center banner off the round `phase`. Each phase sets the big
   * title, up to two supporting lines (line 2 is hidden when unused), and an
   * accent color that also tints the title glow + panel border.
   */
  private updateBanner(state: HudState): void {
    const { round } = state;

    let title: string;
    let line1 = '';
    let line2 = '';
    let accent = SLATE;

    if (round === null) {
      // Pre-ROUND / post-disconnect fallback: reflect the socket instead.
      title = state.status === 'open' ? 'AWAITING ROUND' : 'CONNECTING…';
      accent = state.status === 'open' ? SLATE : AMBER;
    } else {
      switch (round.phase) {
        case 'lobby': {
          const ready = round.readyCount ?? 0;
          const total = round.playerCount ?? 0;
          title = 'LOBBY';
          line1 = `waiting for players · READY ${ready}/${total}`;
          line2 = state.ready
            ? '✔ You are ready'
            : `Press R to ready up (need ${MIN_PLAYERS_TO_START})`;
          accent = SLATE;
          break;
        }
        case 'countdown': {
          title = 'ROUND STARTING';
          line1 = `starting in ${secondsLeft(round.timeLeftMs)}…`;
          accent = AMBER;
          break;
        }
        case 'active': {
          // The big mm:ss clock is the headline during play.
          title = formatClock(round.timeLeftMs);
          line1 = `humans alive: ${round.humansAlive}`;
          accent = SLATE;
          break;
        }
        case 'ended': {
          if (round.winner === 'human') {
            title = 'HUMANS SURVIVED';
            accent = GREEN;
          } else if (round.winner === 'zombie') {
            title = 'THE HORDE WINS';
            accent = RED;
          } else {
            title = 'ROUND OVER';
            accent = SLATE;
          }
          line1 = `Returning to lobby in ${secondsLeft(round.timeLeftMs)}s`;
          break;
        }
        default: {
          // Exhaustive over RoundPhase today; keep a safe fallback for the future.
          title = 'THE CRAWLING DARK';
          break;
        }
      }
    }

    this.bannerTitle.textContent = title;
    this.bannerTitle.style.color = accent;
    this.bannerTitle.style.textShadow = `0 0 18px ${accent}66`;
    this.banner.style.borderColor = `${accent}55`;

    this.bannerLine1.textContent = line1;
    this.bannerLine1.style.display = line1 ? 'block' : 'none';
    this.bannerLine2.textContent = line2;
    this.bannerLine2.style.display = line2 ? 'block' : 'none';
  }

  /* ---- Teardown --------------------------------------------------------- */

  /** Remove both overlays from the container. Idempotent. */
  dispose(): void {
    this.panel.remove();
    this.banner.remove();
  }
}
