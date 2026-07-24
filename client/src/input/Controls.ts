/**
 * Keyboard + mouse input sampling for The Crawling Dark (M2 · t2d).
 *
 * `Controls` turns raw browser input into the two values the network layer
 * streams to the server each frame: a held-key **bitmask** ({@link keys}) and a
 * look **yaw** ({@link yaw}). It uses `KeyboardEvent.code` (physical keys) so the
 * mapping is layout-independent, and clears held movement keys on window blur so
 * a key can never "stick" when focus is lost.
 *
 * Mapping (world-axis; the server interprets direction — see M1 contract):
 *   W/↑ → Forward   S/↓ → Back   A/← → Left   D/→ → Right
 *   Shift → Run     Space → Jump
 *
 * Two inputs are *modes/state* rather than held keys, so they survive blur:
 *   • **C** is a debounced TOGGLE — each press flips crawl on/off; the
 *     {@link InputKey.Crawl} bit is latched into {@link keys} while engaged.
 *   • **Mouse** drives {@link yaw}: horizontal motion accumulates yaw, but only
 *     while the pointer is locked (see {@link attachPointerLock}). This is a
 *     yaw-only ground game, so vertical motion is ignored.
 */

import { InputKey } from '@crawling-dark/shared';

/**
 * Physical `KeyboardEvent.code` → held-input bit (unmapped codes read
 * `undefined`). `KeyC` is intentionally absent: crawl is a toggle, not a held
 * key, and is handled separately in {@link Controls.onKeyDown}.
 */
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
  Space: InputKey.Jump,
};

/** Look sensitivity in radians of yaw per pixel of horizontal mouse motion. */
const MOUSE_SENSITIVITY = 0.0022;

/** Wrap an angle into (-π, π] so accumulated yaw can never grow unbounded. */
function wrapAngle(a: number): number {
  const TWO_PI = Math.PI * 2;
  let x = a % TWO_PI;
  if (x > Math.PI) x -= TWO_PI;
  else if (x <= -Math.PI) x += TWO_PI;
  return x;
}

/**
 * Live keyboard + mouse sampler. Attaches keyboard listeners on construction;
 * call {@link attachPointerLock} once with the canvas to enable mouse look, read
 * {@link keys}/{@link yaw} each frame, and call {@link dispose} on teardown.
 */
export class Controls {
  /** Held movement/action bits (never the latched Crawl bit — see {@link keys}). */
  private bits = 0;
  /** Latched crawl-toggle state; ORed into {@link keys} while `true`. */
  private crawlOn = false;
  /** Accumulated look yaw in radians, wrapped into (-π, π]. */
  private yawValue = 0;
  /** Whether the pointer is currently locked to {@link lockElement}. */
  private locked = false;
  /** Element wired for click-to-lock, or `null` before/after attach. */
  private lockElement: HTMLElement | null = null;
  private readonly target: Window;

  constructor(target: Window = window) {
    this.target = target;
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.target.addEventListener('blur', this.onBlur);
  }

  /**
   * Current held-key bitmask (OR of the active {@link InputKey} bits), including
   * the latched {@link InputKey.Crawl} bit while the crawl toggle is engaged.
   */
  get keys(): number {
    return this.bits | (this.crawlOn ? InputKey.Crawl : 0);
  }

  /** Accumulated look yaw in radians (mouse-driven; only changes while locked). */
  get yaw(): number {
    return this.yawValue;
  }

  /** Whether the crawl toggle is currently engaged. */
  get crawling(): boolean {
    return this.crawlOn;
  }

  /** Whether the pointer is currently locked. */
  get pointerLocked(): boolean {
    return this.locked;
  }

  /**
   * Wire up mouse look on `element`: clicking it requests pointer lock, and
   * while locked, horizontal mouse motion accumulates {@link yaw}. Lock state is
   * tracked from the document's `pointerlockchange` event. Re-attaching to a new
   * element first tears down any previous wiring. All listeners added here are
   * removed by {@link dispose}.
   */
  attachPointerLock(element: HTMLElement): void {
    this.detachPointerLock();
    this.lockElement = element;
    element.addEventListener('click', this.onClickLock);
    const doc = element.ownerDocument;
    doc.addEventListener('pointerlockchange', this.onPointerLockChange);
    doc.addEventListener('mousemove', this.onMouseMove);
  }

  /** Remove all listeners and clear held-key/lock state. */
  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.detachPointerLock();
    this.bits = 0;
  }

  /** Remove the pointer-lock listeners (idempotent) and reset lock state. */
  private detachPointerLock(): void {
    const el = this.lockElement;
    if (el === null) return;
    el.removeEventListener('click', this.onClickLock);
    const doc = el.ownerDocument;
    doc.removeEventListener('pointerlockchange', this.onPointerLockChange);
    doc.removeEventListener('mousemove', this.onMouseMove);
    this.lockElement = null;
    this.locked = false;
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    // Crawl is a debounced toggle: flip on the first keydown, ignore the
    // OS auto-repeat stream so a long hold doesn't rapidly toggle it.
    if (ev.code === 'KeyC') {
      if (ev.repeat) return;
      this.crawlOn = !this.crawlOn;
      return;
    }
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

  /**
   * Clear held movement keys when the window loses focus so no key stays "held".
   * The crawl toggle and accumulated yaw are modes/state, not held keys, so they
   * intentionally persist across blur.
   */
  private readonly onBlur = (): void => {
    this.bits = 0;
  };

  /** Click on the attached element requests pointer lock. */
  private readonly onClickLock = (): void => {
    this.lockElement?.requestPointerLock();
  };

  /** Track lock state: locked only while the browser owns our element. */
  private readonly onPointerLockChange = (): void => {
    const el = this.lockElement;
    this.locked = el !== null && el.ownerDocument.pointerLockElement === el;
  };

  /** Accumulate yaw from horizontal motion — only while pointer-locked. */
  private readonly onMouseMove = (ev: MouseEvent): void => {
    if (!this.locked) return;
    this.yawValue = wrapAngle(this.yawValue - ev.movementX * MOUSE_SENSITIVITY);
  };
}
