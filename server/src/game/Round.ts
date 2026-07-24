import {
  COUNTDOWN_MS,
  ROUND_LENGTH_MS,
  ROUND_END_MS,
  type EntityKind,
  type RoundPhase,
} from '@crawling-dark/shared';

/**
 * Authoritative round state machine for The Crawling Dark (M5 · t5a/t5b/t5c).
 *
 * This is a small, side-effect-free **value object**: it owns exactly three
 * things — the current {@link RoundPhase}, a single millisecond countdown timer
 * for that phase, and (once decided) the {@link winner}. It knows nothing about
 * players, sockets, NPCs, or the world; the {@link Room} reads live counts every
 * tick, decides when to change phase, and performs all the side effects
 * (spawning/removing the patient-zero zombie, resetting players, buffering
 * events). Keeping the machine this thin makes the lifecycle trivial to reason
 * about and to unit-test in isolation.
 *
 * Lifecycle (durations from {@link constants}):
 * ```
 *   lobby ──ready-up──▶ countdown(COUNTDOWN_MS) ──timer 0──▶ active(ROUND_LENGTH_MS)
 *     ▲                      │ too few players                  │ win / lose
 *     │                      ▼                                  ▼
 *     └──────────────── (fall back) ──────────  ended(ROUND_END_MS) ──timer 0──┘
 * ```
 *
 * Timekeeping is deliberately **deterministic**: the timer is a plain remaining-
 * ms counter decremented by a fixed `dtMs` each fixed step (never read off a
 * wall clock), exactly like the combat timers on {@link Player}. This keeps the
 * whole round in lockstep with the fixed-timestep simulation so replays and the
 * client's countdown never disagree with the server.
 */
export class Round {
  /** Current lifecycle phase; the machine always starts idle in the lobby. */
  private _phase: RoundPhase = 'lobby';

  /**
   * Milliseconds left in the current phase. Set to the phase's full duration on
   * entry and decremented by {@link tick}; may drift slightly negative between
   * the crossing and the next transition, which is why {@link timeLeftMs} clamps.
   * The lobby carries no clock, so this rests at 0 there.
   */
  private timerMs = 0;

  /** The victorious side, set once by {@link toEnded} and cleared on any other transition. */
  private _winner: EntityKind | undefined = undefined;

  /** The phase the room is currently in (drives combat gating + the ROUND wire message). */
  get phase(): RoundPhase {
    return this._phase;
  }

  /** The winning side while (and only while) {@link phase} is `'ended'`; otherwise `undefined`. */
  get winner(): EntityKind | undefined {
    return this._winner;
  }

  /**
   * Milliseconds remaining in the current phase as a **non-negative integer**,
   * suitable to put straight on the wire. `ceil` reports "1 ms" rather than a
   * fractional tail so a client clock never flickers to 0 a tick early, and the
   * `max(0, …)` floors the brief negative overshoot between a timer crossing 0
   * and the Room performing the resulting transition.
   */
  get timeLeftMs(): number {
    return Math.max(0, Math.ceil(this.timerMs));
  }

  /**
   * Enter the **lobby**: idle, waiting for players to ready up. No clock runs
   * and any previous winner is forgotten. The Room pairs this with a world reset
   * (turn everyone back to a fresh human, drop the NPC) so the lobby is clean.
   */
  toLobby(): void {
    this._phase = 'lobby';
    this.timerMs = 0;
    this._winner = undefined;
  }

  /**
   * Enter the **countdown**: enough players have readied up, so start the
   * {@link COUNTDOWN_MS} pre-round clock. The Room falls back to the lobby if the
   * active roster drops below the start threshold before it expires.
   */
  toCountdown(): void {
    this._phase = 'countdown';
    this.timerMs = COUNTDOWN_MS;
    this._winner = undefined;
  }

  /**
   * Enter the **active** round: arm the {@link ROUND_LENGTH_MS} (5:00) survival
   * clock. The Room spawns the single patient-zero zombie on this transition and
   * begins running the AI + combat/infection pipeline while this phase holds.
   */
  toActive(): void {
    this._phase = 'active';
    this.timerMs = ROUND_LENGTH_MS;
    this._winner = undefined;
  }

  /**
   * Enter the **ended** results phase with a decided `winner`, arming the short
   * {@link ROUND_END_MS} scoreboard clock before the Room resets back to the
   * lobby. `winner` is surfaced on the ROUND message only while this phase holds.
   */
  toEnded(winner: EntityKind): void {
    this._phase = 'ended';
    this.timerMs = ROUND_END_MS;
    this._winner = winner;
  }

  /**
   * Advance the current phase's clock by one fixed step. Called by the Room once
   * per tick with `dtMs = TICK_MS`; the Room then reads {@link timeLeftMs} to
   * decide whether the phase has elapsed. A no-op-shaped call in the lobby
   * (where the timer already rests at 0) is harmless, but the Room simply never
   * ticks there since the lobby waits on readiness, not a clock.
   */
  tick(dtMs: number): void {
    this.timerMs -= dtMs;
  }
}
