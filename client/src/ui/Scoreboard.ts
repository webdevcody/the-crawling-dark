/**
 * The Crawling Dark — scoreboard / player roster overlay (M15 · t15b).
 *
 * `Scoreboard` is the held-Tab modal that answers "who is still in this round?"
 * at a glance. Unlike the always-on {@link HUD}, it is a centered, dismissable
 * panel that integration binds to holding the Tab key: shown while the key is
 * down, hidden the instant it comes up. It appends a single fixed-position DOM
 * panel to a container passed in the constructor and, like the HUD, stays
 * click-through (`pointer-events:none`) and non-selectable so it never steals
 * input from the canvas underneath.
 *
 * The panel has two parts:
 *
 *   - a **header** — a "SURVIVORS" title plus a one-line summary of the round
 *     assembled from the latest ROUND frame: humans alive, the infected count,
 *     and — during `countdown`/`active` — an mm:ss clock of `timeLeftMs` (other
 *     phases show the phase word instead);
 *   - a **body** — one row per present entity, humans-first then by id ascending,
 *     each with a team-colored dot (green human / red zombie), its `#id`, a `you`
 *     tag + highlight on the local player's row, a team label, and a status word
 *     derived from its {@link EntityState} (`downed`, `stunned`, `crawling`,
 *     `running`, else `alive`/`infected`).
 *
 * The panel shell + header are built ONCE in the constructor; {@link update}
 * refreshes the header text in place and rebuilds the (variable-length) roster
 * rows. That rebuild only ever runs while the panel is visible — Tab is a
 * momentary hold, not a per-frame cost of a running match — so a simple
 * clear-and-re-append keeps the code obvious without allocating during normal
 * play. Before the first ROUND arrives — or with no entities / a null id — it
 * degrades to `—` placeholders and an empty-roster line instead of throwing.
 *
 * Like the rest of the client UI it depends only on the DOM + shared wire types
 * (no Three.js), mirroring the render-agnostic split the HUD uses.
 */

import { MAX_PLAYERS, type RoundMessage, type EntityKind } from '@crawling-dark/shared';
import type { InterpolatedEntity } from '../net/Interpolation';

/* -------------------------------------------------------------------------- */
/* Palette + helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Hopeful green — humans / the local player's own highlight. */
const GREEN = '#53ffa8';
/** Ominous red — the horde / zombies. */
const RED = '#ff6b6b';
/** Energetic amber — reserved accent (matches the HUD countdown tint). */
const AMBER = '#ffd24a';
/** Calm slate — the resting overlay text color. */
const SLATE = '#c8d6e5';
/** Muted slate — placeholders, labels, and secondary lines. */
const DIM = '#7f8c9a';

/**
 * How many roster rows to render before collapsing the tail into a "+N more"
 * line: the full player cap ({@link MAX_PLAYERS}) plus headroom for a handful of
 * NPC zombies, so a normal room always fits and a pathological entity list can
 * never balloon the panel off-screen.
 */
const MAX_NPC_ROWS = 6;
const MAX_ROWS = MAX_PLAYERS + MAX_NPC_ROWS;

/**
 * Format a millisecond duration as `M:SS` (e.g. `247000` -> `4:07`). Uses `ceil`
 * so a fresh 5:00 round reads `5:00` and only hits `0:00` at the very end, and
 * clamps negatives to `0:00`. Mirrors the HUD clock exactly so the roster's
 * summary and the HUD banner never disagree by a second.
 */
function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Human-readable team label for a row (capitalized for the roster look). */
function teamLabel(kind: EntityKind): string {
  return kind === 'human' ? 'Human' : 'Zombie';
}

/**
 * Map an entity's kind + movement/animation state to a short roster status word.
 * The distinctive states read literally (`down` -> `downed`, `stun` -> `stunned`,
 * `crawl` -> `crawling`, `run` -> `running`); every ordinary state collapses to
 * the team's baseline — `alive` for a human, `infected` for a zombie.
 */
function statusLabel(kind: InterpolatedEntity['kind'], state: InterpolatedEntity['state']): string {
  switch (state) {
    case 'down':
      return 'downed';
    case 'stun':
      return 'stunned';
    case 'crawl':
      return 'crawling';
    case 'run':
      return 'running';
    default:
      return kind === 'zombie' ? 'infected' : 'alive';
  }
}

/* -------------------------------------------------------------------------- */
/* Scoreboard                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The held-Tab roster overlay. Construct it once with the container to mount into
 * (the same `#app` div the renderer + HUD live in), call {@link update} every
 * frame it is visible, drive visibility with {@link setVisible} / {@link toggle}
 * (integration binds these to the Tab key), and {@link dispose} on teardown.
 */
export class Scoreboard {
  private readonly container: HTMLElement;

  /** The centered modal shell (built once; shown/hidden via `display`). */
  private readonly panel: HTMLDivElement;
  /** Header summary line — mutated in place each frame (never re-parented). */
  private readonly summary: HTMLDivElement;
  /** Body container — its roster rows are cleared and rebuilt each frame. */
  private readonly body: HTMLDivElement;

  /** The `display` value used while shown (the panel is `none` when hidden). */
  private static readonly SHOWN_DISPLAY = 'flex';

  private shown = false;

  constructor(container: HTMLElement) {
    this.container = container;

    /* -- Centered modal shell (mirrors the HUD overlay look) --------------- */
    // Dark, translucent, monospace, blurred — and, like the HUD, click-through
    // and non-selectable so holding Tab never interferes with the canvas. Pinned
    // dead-center and hidden by default; `setVisible` flips `display`.
    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      padding: '14px 20px',
      font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: SLATE,
      background: 'rgba(5, 7, 10, 0.72)',
      border: '1px solid rgba(58, 90, 106, 0.5)',
      borderRadius: '8px',
      pointerEvents: 'none',
      userSelect: 'none',
      backdropFilter: 'blur(2px)',
      display: 'none',
      flexDirection: 'column',
      gap: '8px',
      minWidth: '340px',
      maxWidth: '80vw',
    } satisfies Partial<CSSStyleDeclaration>);

    /* -- Header: title + round summary ------------------------------------- */
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '16px',
      paddingBottom: '6px',
      borderBottom: '1px solid rgba(58, 90, 106, 0.5)',
    } satisfies Partial<CSSStyleDeclaration>);

    const title = document.createElement('b');
    title.textContent = 'SURVIVORS';
    Object.assign(title.style, {
      letterSpacing: '0.08em',
      color: SLATE,
    } satisfies Partial<CSSStyleDeclaration>);

    this.summary = document.createElement('div');
    this.summary.style.color = DIM;

    header.append(title, this.summary);
    this.panel.append(header);

    /* -- Body: the roster rows (rebuilt per frame) ------------------------- */
    this.body = document.createElement('div');
    Object.assign(this.body.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
    } satisfies Partial<CSSStyleDeclaration>);
    this.panel.append(this.body);

    this.container.append(this.panel);
    // Seed the header so the panel reads sensibly even before the first update.
    this.renderSummary(null);
  }

  /* ---- Per-frame update ------------------------------------------------- */

  /**
   * Refresh the roster for one frame from the interpolated entities + ROUND.
   * A no-op while hidden (Tab isn't held), so a running match pays nothing for
   * a panel nobody is looking at. While visible it rewrites the summary text in
   * place and rebuilds the roster rows from scratch — cheap, since it only runs
   * for the brief windows the panel is up. Tolerant of empty/null inputs.
   */
  update(
    entities: Map<number, InterpolatedEntity>,
    localId: number | null,
    round: RoundMessage | null,
  ): void {
    if (!this.shown) return;

    this.renderSummary(round);
    this.renderRows(entities, localId);
  }

  /**
   * Rewrite the header summary from the round frame: `humans N · infected N`
   * plus an mm:ss clock while counting down / active, or the phase word for the
   * lobby / results. Degrades to `—` placeholders when no ROUND has arrived.
   */
  private renderSummary(round: RoundMessage | null): void {
    if (round === null) {
      this.summary.textContent = 'humans — · infected — · —';
      this.summary.style.color = DIM;
      return;
    }
    const tail =
      round.phase === 'active' || round.phase === 'countdown'
        ? formatClock(round.timeLeftMs)
        : round.phase;
    this.summary.textContent = `humans ${round.humansAlive} · infected ${round.zombieCount} · ${tail}`;
    // Flag the imminent start in amber, matching the HUD's countdown accent.
    this.summary.style.color = round.phase === 'countdown' ? AMBER : DIM;
  }

  /**
   * Rebuild the body rows for the current entity set: sort humans-first then by
   * id ascending, cap at {@link MAX_ROWS} (collapsing any overflow into a
   * "+N more" line), and re-append. Falls back to a single muted placeholder
   * when there are no entities to show.
   */
  private renderRows(entities: Map<number, InterpolatedEntity>, localId: number | null): void {
    this.body.replaceChildren();

    const sorted = [...entities.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'human' ? -1 : 1;
      return a.id - b.id;
    });

    if (sorted.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '— no one here yet —';
      empty.style.color = DIM;
      this.body.append(empty);
      return;
    }

    const shown = sorted.slice(0, MAX_ROWS);
    for (const entity of shown) {
      this.body.append(this.makeRow(entity, entity.id === localId));
    }

    const overflow = sorted.length - shown.length;
    if (overflow > 0) {
      const more = document.createElement('div');
      more.textContent = `+${overflow} more`;
      more.style.color = DIM;
      this.body.append(more);
    }
  }

  /** Build one roster row: team dot · id · you-tag · team · status. */
  private makeRow(entity: InterpolatedEntity, isLocal: boolean): HTMLDivElement {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '1px 6px',
      borderRadius: '4px',
    } satisfies Partial<CSSStyleDeclaration>);
    // Highlight the local player's row: a green accent + weight, plus a faint
    // tint. The per-column colors below win over the inherited row color, so the
    // team dot and label keep their own hues even when the row is "you".
    if (isLocal) {
      row.style.color = GREEN;
      row.style.fontWeight = '700';
      row.style.background = 'rgba(83, 255, 168, 0.08)';
    }

    // Team dot — green human, red zombie.
    const dot = document.createElement('span');
    dot.textContent = '●';
    dot.style.color = entity.kind === 'human' ? GREEN : RED;

    // Entity id, fixed-width so the columns after it line up.
    const id = document.createElement('span');
    id.textContent = `#${entity.id}`;
    Object.assign(id.style, {
      display: 'inline-block',
      width: '5ch',
    } satisfies Partial<CSSStyleDeclaration>);

    // "you" tag — a reserved fixed-width column (empty for everyone else) so the
    // local highlight never shifts the surrounding columns.
    const tag = document.createElement('span');
    Object.assign(tag.style, {
      display: 'inline-block',
      width: '4ch',
      color: GREEN,
    } satisfies Partial<CSSStyleDeclaration>);
    tag.textContent = isLocal ? 'you' : '';

    // Team label.
    const team = document.createElement('span');
    team.textContent = teamLabel(entity.kind);
    Object.assign(team.style, {
      display: 'inline-block',
      width: '7ch',
      color: DIM,
    } satisfies Partial<CSSStyleDeclaration>);

    // Status word derived from state (+ kind).
    const status = document.createElement('span');
    status.textContent = statusLabel(entity.kind, entity.state);

    row.append(dot, id, tag, team, status);
    return row;
  }

  /* ---- Visibility ------------------------------------------------------- */

  /** Show or hide the panel (integration binds this to holding Tab). */
  setVisible(visible: boolean): void {
    if (this.shown === visible) return;
    this.shown = visible;
    this.panel.style.display = visible ? Scoreboard.SHOWN_DISPLAY : 'none';
  }

  /** Flip visibility — the toggle counterpart to {@link setVisible}. */
  toggle(): void {
    this.setVisible(!this.shown);
  }

  /** Whether the panel is currently shown. */
  get visible(): boolean {
    return this.shown;
  }

  /* ---- Teardown --------------------------------------------------------- */

  /** Remove the overlay from the container. Idempotent. */
  dispose(): void {
    this.panel.remove();
  }
}
