/**
 * Keyboard input sampling for The Crawling Dark (M1 · t1d/t1e).
 *
 * `Controls` translates raw keydown/keyup events into the live held-key
 * bitmask the network layer streams to the server. It uses `KeyboardEvent.code`
 * (physical keys) so the mapping is layout-independent, and clears all keys on
 * window blur so a held key can never "stick" when focus is lost.
 *
 * Mapping (world-axis; the server interprets direction — see M1 contract):
 *   W → Forward   S → Back   A → Left   D → Right
 *   Shift → Run   C → Crawl  Space → Jump
 */

import { InputKey } from '@crawling-dark/shared';

/** Physical `KeyboardEvent.code` → input bit (unmapped codes read `undefined`). */
const KEY_MAP: Readonly<Record<string, InputKey | undefined>> = {
  KeyW: InputKey.Forward,
  KeyS: InputKey.Back,
  KeyA: InputKey.Left,
  KeyD: InputKey.Right,
  ArrowUp: InputKey.Forward,
  ArrowDown: InputKey.Back,
  ArrowLeft: InputKey.Left,
  ArrowRight: InputKey.Right,
  ShiftLeft: InputKey.Run,
  ShiftRight: InputKey.Run,
  KeyC: InputKey.Crawl,
  Space: InputKey.Jump,
};

/**
 * Live keyboard sampler. Attaches listeners on construction; read {@link keys}
 * each frame and call {@link dispose} on teardown.
 */
export class Controls {
  private bits = 0;
  private readonly target: Window;

  constructor(target: Window = window) {
    this.target = target;
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.target.addEventListener('blur', this.onBlur);
  }

  /** Current held-key bitmask (OR of the active {@link InputKey} bits). */
  get keys(): number {
    return this.bits;
  }

  /** Remove listeners and clear state. */
  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.bits = 0;
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    const bit = KEY_MAP[ev.code];
    if (bit === undefined) return;
    // Space would otherwise scroll the page; keep focus on the game.
    if (ev.code === 'Space') ev.preventDefault();
    this.bits |= bit;
  };

  private readonly onKeyUp = (ev: KeyboardEvent): void => {
    const bit = KEY_MAP[ev.code];
    if (bit === undefined) return;
    this.bits &= ~bit;
  };

  /** Clear everything when the window loses focus so no key stays "held". */
  private readonly onBlur = (): void => {
    this.bits = 0;
  };
}
