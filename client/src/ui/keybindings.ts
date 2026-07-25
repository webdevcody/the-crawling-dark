/**
 * The Crawling Dark — canonical keybinding reference (M16 · t16b).
 *
 * A single, typed source of truth for the game's controls: the flat, ordered
 * {@link KEYBINDINGS} list every controls-facing surface reads from, so the
 * {@link HelpOverlay} (and any future rebind UI) never hard-codes its own copy
 * and can never drift from what the game actually listens for.
 *
 * Each {@link Keybinding} pairs a human-readable key label with the action it
 * performs and the {@link KeybindingGroup} it belongs under (Movement / Combat /
 * Interface), matching the real handlers in `input/Controls.ts` (WASD move, Shift
 * run, C crawl toggle, Space jump) and `main.ts` (left-click swing, R ready, Tab
 * scoreboard, O options, N minimap, P post-fx, M mute, ` perf, plus the two M16
 * additions — H/? controls and Esc pause).
 *
 * This module is **pure**: it touches no DOM, holds no state, and has zero side
 * effects, so it is safe to import from anywhere. Turning these labels into a
 * visible overlay — and wiring `H`/`?` to toggle it — is the integration task
 * (t16e); this file only describes the bindings.
 */

/** The three sections controls are grouped under, in display order. */
export type KeybindingGroup = 'Movement' | 'Combat' | 'Interface';

/**
 * The section headings, in the order the reference overlay renders them. Kept
 * beside {@link KEYBINDINGS} so a consumer can iterate groups deterministically
 * without re-deriving the order from the (unordered) set of `group` values.
 */
export const KEYBINDING_GROUPS: readonly KeybindingGroup[] = [
  'Movement',
  'Combat',
  'Interface',
] as const;

/** One control: a human-readable key label, the action it triggers, its group. */
export interface Keybinding {
  /** Human-readable key label (e.g. `'W A S D'`, `'Left Click'`, `` '`' ``). */
  readonly key: string;
  /** What the key does, in plain words (e.g. `'Move'`, `'Swing bat'`). */
  readonly action: string;
  /** The section this binding is listed under. */
  readonly group: KeybindingGroup;
}

/**
 * The canonical, ordered controls list. Grouped Movement → Combat → Interface to
 * match {@link KEYBINDING_GROUPS}; labels are display-ready. Mirrors the live
 * handlers — do not add a row here without a matching binding in the game.
 */
export const KEYBINDINGS: readonly Keybinding[] = [
  // Movement — sampled by input/Controls.ts (physical KeyboardEvent.code).
  { key: 'W  A  S  D', action: 'Move', group: 'Movement' },
  { key: 'Shift', action: 'Run', group: 'Movement' },
  { key: 'Ctrl  /  C', action: 'Crawl (toggle)', group: 'Movement' },
  { key: 'Space', action: 'Jump', group: 'Movement' },

  // Combat.
  { key: 'Left Click', action: 'Swing bat', group: 'Combat' },
  { key: 'R', action: 'Ready up (lobby)', group: 'Combat' },

  // Interface — HUD / menu shortcuts wired in main.ts.
  { key: 'Tab', action: 'Scoreboard (hold)', group: 'Interface' },
  { key: 'O', action: 'Options / settings', group: 'Interface' },
  { key: 'N', action: 'Toggle minimap', group: 'Interface' },
  { key: 'P', action: 'Toggle post-processing', group: 'Interface' },
  { key: 'M', action: 'Mute audio', group: 'Interface' },
  { key: '`', action: 'Perf overlay', group: 'Interface' },
  { key: 'H  /  ?', action: 'Controls (this overlay)', group: 'Interface' },
  { key: 'Esc', action: 'Pause menu', group: 'Interface' },
] as const;
