/**
 * The Crawling Dark — procedural audio engine (M6 · t6d).
 *
 * Historically this game shipped **no audio assets**, so every sound here is
 * **synthesized on the fly with the Web Audio API** — oscillators, filtered
 * noise (an {@link AudioBuffer} of random samples), gain envelopes, and stereo
 * panning — and the whole pass builds and runs offline.
 *
 * M12 · t12a adds a **sample path** on top of that synth core: an
 * {@link AssetLibrary} fetches + decodes real one-shot files, and every one-shot
 * ({@link swing}, {@link hit}, {@link infect}, {@link footstep}) plays its
 * recorded buffer when present, **falling back to the synth voice** when the
 * file is missing (offline build, 404, or removed) — see {@link playBuffer}
 *
 * The engine owns a single {@link AudioContext} built lazily on the first user
 * gesture (browsers refuse to start audio before one), and a tiny mixing graph:
 *
 * ```
 *                                   ┌────────────► destination
 *                          masterGain (mute × masterVolume)
 *                          ▲                     ▲
 *                     sfxGain (sfxVolume)   ambientGain (fixed bed level)
 *                          ▲                     ▲
 *        per-sound  panner → distanceGain    looping wind/drone graph
 * ```
 *
 * One-shots ({@link swing}, {@link hit}, {@link infect}, {@link footstep}) each
 * spin up a throwaway sub-graph — a synth voice → an envelope → a
 * {@link StereoPannerNode} + a distance gain derived from the source position
 * versus the current listener ({@link setListener}) — then self-dispose when the
 * voice ends. The {@link startAmbient looping ambient bed} is built once and runs
 * for the session. Volume/mute state is stored on the instance and applied to the
 * bus gains, so the controls work even before the context exists.
 *
 * Everything degrades gracefully: if the context is missing or not `running`,
 * the sound methods no-op rather than throw, and {@link setListener} simply
 * records the latest position for the next audible event.
 */

import { AssetLibrary, type AudioManifest } from './AssetLibrary';

/* -------------------------------------------------------------------------- */
/* Types + tunables                                                           */
/* -------------------------------------------------------------------------- */

/** A world-space point; matches both `localFeet` and an interpolated entity. */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Movement states that produce footsteps, mirroring the sim's {@link EntityState}. */
export type FootstepKind = 'walk' | 'run' | 'crawl';

/**
 * The ground a step lands on, chosen by the caller from world data (t12b): hard
 * paving (`'stone'`), soft outskirts earth (`'dirt'`), or the lake's edge
 * (`'wet'`). It nudges a step's cutoff/level/pitch and, on `'wet'`, adds a short
 * bright splash — see {@link SURFACE} and {@link AudioEngine.footstep}.
 */
export type FootstepSurface = 'stone' | 'dirt' | 'wet';

/** Result of projecting a source position into a stereo pan + distance gain. */
interface Spatial {
  /** Stereo pan in [-1, 1] (left → right), from the listener-relative bearing. */
  pan: number;
  /** Distance attenuation in (0, 1], from `1 / (1 + d / REF_DIST)`. */
  gain: number;
}

/** Reference distance (m) at which distance gain has fallen to one half. */
const REF_DIST = 7;

/** Hard cull radius (m): sources beyond this are silent (and never synthesized). */
const MAX_AUDIBLE = 42;

/** Default bus volumes (0..1); overridable via the setters + on-screen controls. */
const DEFAULT_MASTER = 0.8;
const DEFAULT_SFX = 0.9;

/** Fixed level of the looping ambient bed, relative to the master bus. */
const AMBIENT_LEVEL = 0.6;

/** Per-speed footstep character: playback rate, low-pass cutoff, level, duration. */
const FOOTSTEP: Readonly<Record<FootstepKind, {
  rate: number;
  freq: number;
  peak: number;
  dur: number;
}>> = {
  // A brisk mid thud.
  walk: { rate: 1.0, freq: 900, peak: 0.5, dur: 0.11 },
  // Faster, brighter, harder — a sprinting stomp.
  run: { rate: 1.25, freq: 1300, peak: 0.72, dur: 0.09 },
  // Muffled, low, and soft — dragging along the ground.
  crawl: { rate: 0.8, freq: 520, peak: 0.34, dur: 0.16 },
};

/**
 * Per-surface tweaks layered on top of {@link FOOTSTEP} (t12b). Each field is a
 * multiplier on the step's playback rate / low-pass cutoff / level, plus a
 * `splash` level (0 = none) for a short high band of noise on top — the give-away
 * of a wet edge. `'stone'` is the neutral identity so existing behaviour is
 * unchanged when no surface is supplied.
 */
const SURFACE: Readonly<Record<FootstepSurface, {
  rate: number;
  freq: number;
  peak: number;
  splash: number;
}>> = {
  // Hard paving: bright and sharp — the default identity (all ×1).
  stone: { rate: 1.0, freq: 1.0, peak: 1.0, splash: 0.0 },
  // Soft outskirts earth: darker, quieter, a touch slower — a muffled scuff.
  dirt: { rate: 0.95, freq: 0.6, peak: 0.82, splash: 0.0 },
  // The lake's edge: damped body plus a bright little splash of displaced water.
  wet: { rate: 0.92, freq: 0.78, peak: 0.9, splash: 0.4 },
};

/** Clamp `x` into the inclusive range [`lo`, `hi`]. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Built-in sample set (M12 · t12a). Logical name -> file under `client/public/`
 * (served at the app root by Vite). Anything here that fails to load — or is
 * removed from the build — transparently falls back to the synth voice, so the
 * game still makes sound offline. Later tasks add more via
 * {@link AudioEngine.loadSamples}.
 */
const SAMPLE_MANIFEST: AudioManifest = {
  swing: 'audio/sfx/swing.wav',
  hit: 'audio/sfx/impact.wav',
  footstep: 'audio/sfx/footstep.wav',
};

/** Optional shaping for {@link AudioEngine.playBuffer}. */
export interface SampleOptions {
  /** Linear level multiplier applied before the spatializer (default 1). */
  gain?: number;
  /** Playback-rate multiplier — repitches + retimes the sample (default 1). */
  rate?: number;
  /** Start offset into the buffer in seconds (default 0). */
  offset?: number;
}

/* -------------------------------------------------------------------------- */
/* AudioEngine                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The whole game's audio, self-contained. Construct once, call {@link resume}
 * (and {@link startAmbient}) from the first user gesture, feed it the listener
 * position each frame with {@link setListener}, and trigger positional one-shots
 * from gameplay events + the footstep driver.
 */
export class AudioEngine {
  /** The audio graph's context, or `null` until the first {@link resume}. */
  private ctx: AudioContext | null = null;

  /** Master bus: `mute ? 0 : masterVolume`, feeding the destination. */
  private masterGain: GainNode | null = null;
  /** SFX sub-bus (one-shots route here), scaled by {@link sfxVolume}. */
  private sfxGain: GainNode | null = null;
  /** Ambient sub-bus (the looping bed routes here), held at {@link AMBIENT_LEVEL}. */
  private ambientGain: GainNode | null = null;

  /** Cached white-noise buffer reused by every filtered-noise voice. */
  private noiseBuffer: AudioBuffer | null = null;

  /** Guards {@link startAmbient} so the bed is only ever built once. */
  private ambientStarted = false;

  /** Live master volume in [0, 1] (applied through the mute multiplier). */
  private master = DEFAULT_MASTER;
  /** Live SFX volume in [0, 1]. */
  private sfx = DEFAULT_SFX;
  /** Whether all output is muted (master forced to silence). */
  private isMuted = false;

  /** The listener's world position (from `localFeet`), updated each frame. */
  private readonly listener: Point3 = { x: 0, y: 0, z: 0 };
  /** The listener's look yaw (radians), so panning tracks the camera facing. */
  private listenerYaw = 0;

  /** Sample library (real assets); consulted per one-shot for sample-vs-synth. */
  private readonly library = new AssetLibrary();
  /** Accumulated manifest to (re)load whenever the context comes up (t12a). */
  private pendingManifest: Record<string, string> = { ...SAMPLE_MANIFEST };

  /* ---- Lifecycle -------------------------------------------------------- */

  /**
   * Create the context (if needed) and resume it. MUST be called from a user
   * gesture handler (click / keydown) — browsers keep a fresh context
   * `suspended` until then. Idempotent and safe to call on every gesture.
   */
  resume(): void {
    if (this.ctx === null) this.build();
    // `resume()` returns a promise; we don't await it — the graph plays as soon
    // as the context flips to `running`.
    void this.ctx?.resume();
  }

  /** Lazily construct the context + bus graph and cache the noise buffer. */
  private build(): void {
    // Typed as possibly-undefined so a Web-Audio-less environment fails soft
    // (and to sidestep the "no overlap" comparison error on the global type).
    const Ctor: typeof AudioContext | undefined = window.AudioContext;
    if (!Ctor) return; // no Web Audio → the engine stays silent.
    const ctx = new Ctor();

    const master = ctx.createGain();
    master.connect(ctx.destination);

    const sfx = ctx.createGain();
    sfx.connect(master);

    const ambient = ctx.createGain();
    ambient.connect(master);

    this.ctx = ctx;
    this.masterGain = master;
    this.sfxGain = sfx;
    this.ambientGain = ambient;
    this.noiseBuffer = this.makeNoise(ctx, 1.5);

    // Kick off sample loading (t12a). Async + fire-and-forget: one-shots synth-
    // fall-back until buffers arrive, and any file that 404s stays on the synth.
    void this.library.load(ctx, this.pendingManifest);

    this.applyGains(0); // snap the bus gains to the stored volumes/mute state.
  }

  /**
   * Release the context on teardown so timers/oscillators stop cleanly. Safe to
   * call when nothing was ever started.
   */
  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.masterGain = null;
    this.sfxGain = null;
    this.ambientGain = null;
    this.ambientStarted = false;
  }

  /* ---- Volume + mute ---------------------------------------------------- */

  /** Current master volume in [0, 1]. */
  get masterVolume(): number {
    return this.master;
  }

  /** Current SFX volume in [0, 1]. */
  get sfxVolume(): number {
    return this.sfx;
  }

  /** Whether output is currently muted. */
  get muted(): boolean {
    return this.isMuted;
  }

  /** Set the master volume (clamped to [0, 1]); takes effect immediately. */
  setMasterVolume(v: number): void {
    this.master = clamp(v, 0, 1);
    this.applyGains();
  }

  /** Set the SFX-bus volume (clamped to [0, 1]); takes effect immediately. */
  setSfxVolume(v: number): void {
    this.sfx = clamp(v, 0, 1);
    this.applyGains();
  }

  /** Force the mute state on/off. */
  setMuted(b: boolean): void {
    this.isMuted = b;
    this.applyGains();
  }

  /** Flip the mute state and return the new value (for the on-screen button). */
  toggleMute(): boolean {
    this.setMuted(!this.isMuted);
    return this.isMuted;
  }

  /**
   * Push the stored volumes/mute onto the live bus gains. Ramps over `ramp`
   * seconds (default a short 20 ms) so a mute or slider drag never clicks.
   */
  private applyGains(ramp = 0.02): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const now = ctx.currentTime;
    const masterTarget = this.isMuted ? 0 : this.master;
    // `setTargetAtTime`'s time-constant reaches ~63% per unit; `ramp/3` lands it
    // essentially on target within `ramp` seconds without an audible step.
    this.masterGain?.gain.setTargetAtTime(masterTarget, now, Math.max(ramp / 3, 0.001));
    this.sfxGain?.gain.setTargetAtTime(this.sfx, now, Math.max(ramp / 3, 0.001));
    if (!this.ambientStarted) {
      // Hold the bed muted until it actually starts, then it fades in itself.
      this.ambientGain?.gain.setValueAtTime(0, now);
    }
  }

  /* ---- Listener --------------------------------------------------------- */

  /**
   * Record the listener's world position + look yaw for subsequent positional
   * sounds. Called every render frame from `localFeet` / `controls.yaw`. Cheap:
   * it only copies four numbers and needs no live context.
   */
  setListener(pos: Point3, yaw = 0): void {
    this.listener.x = pos.x;
    this.listener.y = pos.y;
    this.listener.z = pos.z;
    this.listenerYaw = yaw;
  }

  /* ---- Ambient bed ------------------------------------------------------ */

  /**
   * Start the looping "dark town" bed once the context is running: a slow band
   * of filtered brown-noise wind, a pair of faintly detuned sub-bass drones
   * (their beat adds unease), and two languid LFOs that breathe the wind's
   * cutoff and level so the bed never sits still. Built exactly once; safe to
   * call on every gesture.
   */
  startAmbient(): void {
    const ctx = this.ctx;
    if (ctx === null || this.ambientGain === null || this.ambientStarted) return;
    this.ambientStarted = true;
    const t0 = ctx.currentTime;

    // Fade the bed in over ~2.5 s so it swells up rather than popping on.
    this.ambientGain.gain.setValueAtTime(0, t0);
    this.ambientGain.gain.linearRampToValueAtTime(AMBIENT_LEVEL, t0 + 2.5);

    // ── Wind: looping brown noise through a slow, breathing low-pass ──
    const wind = ctx.createBufferSource();
    wind.buffer = this.makeBrownNoise(ctx, 5);
    wind.loop = true;

    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 320;
    windFilter.Q.value = 0.7;

    const windGain = ctx.createGain();
    windGain.gain.value = 0.5;

    wind.connect(windFilter).connect(windGain).connect(this.ambientGain);

    // ── Sub-bass drones: two close sines whose beat gives a low unease ──
    const droneA = ctx.createOscillator();
    droneA.type = 'sine';
    droneA.frequency.value = 48;
    const droneAGain = ctx.createGain();
    droneAGain.gain.value = 0.14;
    droneA.connect(droneAGain).connect(this.ambientGain);

    const droneB = ctx.createOscillator();
    droneB.type = 'sine';
    droneB.frequency.value = 54.7; // slight detune → a slow ~7 Hz beat
    const droneBGain = ctx.createGain();
    droneBGain.gain.value = 0.09;
    droneB.connect(droneBGain).connect(this.ambientGain);

    // ── LFOs: breathe the wind cutoff and level ──
    const lfoCut = ctx.createOscillator();
    lfoCut.type = 'sine';
    lfoCut.frequency.value = 0.06;
    const lfoCutGain = ctx.createGain();
    lfoCutGain.gain.value = 120; // cutoff wanders 200..440 Hz
    lfoCut.connect(lfoCutGain).connect(windFilter.frequency);

    const lfoLvl = ctx.createOscillator();
    lfoLvl.type = 'sine';
    lfoLvl.frequency.value = 0.085;
    const lfoLvlGain = ctx.createGain();
    lfoLvlGain.gain.value = 0.18; // level wanders ±0.18 around 0.5
    lfoLvl.connect(lfoLvlGain).connect(windGain.gain);

    for (const node of [wind, droneA, droneB, lfoCut, lfoLvl]) {
      node.start(t0);
    }
  }

  /* ---- Sample playback (real assets, synth fallback) -------------------- */

  /** The loaded sample library; consult `has(name)` to branch sample-vs-synth. */
  get assets(): AssetLibrary {
    return this.library;
  }

  /**
   * Register + (if the context is live) begin loading additional samples beyond
   * the built-in {@link SAMPLE_MANIFEST}. Later audio tasks (expanded SFX, music,
   * environment one-shots) call this to drop their own files in without touching
   * the loader. Safe before the context exists — the manifest is remembered and
   * loaded on the next {@link resume}.
   */
  loadSamples(manifest: AudioManifest): void {
    this.pendingManifest = { ...this.pendingManifest, ...manifest };
    if (this.ctx !== null) void this.library.load(this.ctx, manifest);
  }

  /**
   * Play a loaded sample positionally through the shared {@link oneShot}
   * spatializer (panner + distance gain + SFX bus). Returns `true` when a buffer
   * for `name` exists (and was routed — distance culling still applies), or
   * `false` when the sample is absent, so callers can synth-fall-back:
   *
   * ```ts
   * if (!this.playBuffer('swing', pos)) this.oneShot(pos, synthSwing);
   * ```
   *
   * `opts.rate` repitches, `opts.gain` scales level, `opts.offset` starts partway
   * into the buffer (for grain variety on reused one-shots).
   */
  playBuffer(name: string, pos: Point3, opts: SampleOptions = {}): boolean {
    const buf = this.library.get(name);
    if (buf === undefined) return false;
    const { gain = 1, rate = 1, offset = 0 } = opts;
    this.oneShot(pos, (ctx, t0, dest) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      if (gain === 1) {
        src.connect(dest);
      } else {
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(g).connect(dest);
      }
      src.start(t0, offset);
      return [src];
    });
    return true;
  }

  /* ---- One-shot SFX ----------------------------------------------------- */

  /**
   * A bat **swing whoosh**: band-passed noise whose center frequency sweeps up
   * then falls, shaped by a quick attack + tail. Positioned at the swinger.
   */
  swing(pos: Point3): void {
    // Real sample if present (t12a); otherwise the synth whoosh below.
    if (this.playBuffer('swing', pos, { rate: 0.97 + Math.random() * 0.06 })) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      // Per-swing variety (t12b) so a flurry of bat hits never sounds identical:
      // jitter the noise pitch, the sweep's peak + timing, and its landing tone.
      const vary = 0.9 + Math.random() * 0.2;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.playbackRate.value = 1.1 * vary;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(360 + Math.random() * 90, t0);
      bp.frequency.exponentialRampToValueAtTime(1600 + Math.random() * 500, t0 + 0.08 + Math.random() * 0.03);
      bp.frequency.exponentialRampToValueAtTime(460 + Math.random() * 90, t0 + 0.24);

      const env = this.env(ctx, t0, 0.02, 0.22, 0.44 + Math.random() * 0.12);
      src.connect(bp).connect(env).connect(dest);

      src.start(t0, Math.random() * 0.5);
      src.stop(t0 + 0.26);
      return [src];
    });
  }

  /**
   * A bat **hit impact**: a punchy sine "thock" with a fast downward pitch drop,
   * layered with a bright noise transient click. Positioned at the victim.
   */
  hit(pos: Point3): void {
    // Real sample if present (t12a); otherwise the synth thock below.
    if (this.playBuffer('hit', pos, { rate: 0.97 + Math.random() * 0.06 })) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      // Body: a low sine that snaps from 190 Hz down to 55 Hz.
      const body = ctx.createOscillator();
      body.type = 'sine';
      body.frequency.setValueAtTime(190, t0);
      body.frequency.exponentialRampToValueAtTime(55, t0 + 0.12);
      const bodyEnv = this.env(ctx, t0, 0.002, 0.17, 0.9);
      body.connect(bodyEnv).connect(dest);
      body.start(t0);
      body.stop(t0 + 0.2);

      // Transient: a short band of high noise for the "crack" of contact.
      const click = ctx.createBufferSource();
      click.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2600;
      bp.Q.value = 0.8;
      const clickEnv = this.env(ctx, t0, 0.001, 0.05, 0.5);
      click.connect(bp).connect(clickEnv).connect(dest);
      click.start(t0, Math.random() * 0.5);
      click.stop(t0 + 0.07);

      return [body, click];
    });
  }

  /**
   * An **infection stinger**: a dread hit built from a bending sub-bass, a
   * dissonant minor-second pair that swells, and a rising band of noise. It is
   * deliberately the biggest, most unsettling one-shot. Positioned at the victim.
   */
  infect(pos: Point3): void {
    // Real sample if present (t12a); otherwise the synth stinger below.
    if (this.playBuffer('infect', pos)) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      // Sub-bass that bends downward — the "sinking" feeling of turning.
      const sub = ctx.createOscillator();
      sub.type = 'triangle';
      sub.frequency.setValueAtTime(150, t0);
      sub.frequency.exponentialRampToValueAtTime(60, t0 + 0.5);
      const subEnv = this.env(ctx, t0, 0.01, 0.6, 0.5);
      sub.connect(subEnv).connect(dest);
      sub.start(t0);
      sub.stop(t0 + 0.62);

      // A dissonant minor-second pair that swells in, sold as "wrongness".
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1200;
      const disEnv = this.env(ctx, t0, 0.14, 0.42, 0.2);
      lp.connect(disEnv).connect(dest);

      const toneA = ctx.createOscillator();
      toneA.type = 'sawtooth';
      toneA.frequency.value = 330;
      toneA.connect(lp);
      toneA.start(t0);
      toneA.stop(t0 + 0.58);

      const toneB = ctx.createOscillator();
      toneB.type = 'sawtooth';
      toneB.frequency.value = 349; // ~a semitone above → sour beating
      toneB.connect(lp);
      toneB.start(t0);
      toneB.stop(t0 + 0.58);

      // A rising band of noise underneath for tension.
      const hiss = ctx.createBufferSource();
      hiss.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(300, t0);
      bp.frequency.exponentialRampToValueAtTime(2400, t0 + 0.45);
      const hissEnv = this.env(ctx, t0, 0.05, 0.4, 0.22);
      hiss.connect(bp).connect(hissEnv).connect(dest);
      hiss.start(t0, Math.random() * 0.5);
      hiss.stop(t0 + 0.5);

      return [sub, toneA, toneB, hiss];
    });
  }

  /**
   * A single **footstep**: a short filtered-noise thud whose pitch, cutoff,
   * level, and length vary by {@link FootstepKind} (see {@link FOOTSTEP}), with a
   * little per-step jitter and a random slice of the noise buffer so no two steps
   * sound identical. Positioned at the stepping entity.
   *
   * `surface` (t12b) tilts the character by ground type (see {@link SURFACE}):
   * hard `'stone'` (the default identity), softer/darker `'dirt'` on the
   * outskirts, and damped `'wet'` at the lake edge — the last also layering a
   * short bright splash on top. A surface-specific sample (`footstep_<surface>`)
   * is tried first, then the generic `footstep` sample, then the synth voice.
   */
  footstep(pos: Point3, kind: FootstepKind, surface: FootstepSurface = 'stone'): void {
    const p = FOOTSTEP[kind];
    const sm = SURFACE[surface];
    // Real sample if present (t12a): reuse the per-kind rate + relative level,
    // shaped by the surface; otherwise fall through to the synthesized thud.
    const rate = p.rate * sm.rate * (0.94 + Math.random() * 0.12);
    const gain = (p.peak * sm.peak) / 0.85;
    if (surface !== 'stone' && this.playBuffer(`footstep_${surface}`, pos, { rate, gain })) return;
    if (this.playBuffer('footstep', pos, { rate, gain })) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.playbackRate.value = p.rate * sm.rate * (0.94 + Math.random() * 0.12);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = p.freq * sm.freq * (0.9 + Math.random() * 0.2);
      lp.Q.value = 0.9;

      const env = this.env(ctx, t0, 0.004, p.dur, p.peak * sm.peak * (0.85 + Math.random() * 0.3));
      src.connect(lp).connect(env).connect(dest);

      // A random offset into the noise gives each step a distinct grain.
      const buf = this.noiseBuffer;
      const off = buf ? Math.random() * Math.max(0, buf.duration - p.dur - 0.02) : 0;
      src.start(t0, off);
      src.stop(t0 + p.dur + 0.02);
      const sources: AudioScheduledSourceNode[] = [src];

      // Wet ground: a short, bright band of noise on top — displaced water.
      if (sm.splash > 0) {
        const spl = ctx.createBufferSource();
        spl.buffer = this.noiseBuffer;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 0.7;
        bp.frequency.setValueAtTime(1400, t0);
        bp.frequency.exponentialRampToValueAtTime(3200, t0 + 0.05);
        const splEnv = this.env(ctx, t0, 0.003, 0.09, sm.splash * p.peak);
        spl.connect(bp).connect(splEnv).connect(dest);
        spl.start(t0, Math.random() * 0.5);
        spl.stop(t0 + 0.11);
        sources.push(spl);
      }
      return sources;
    });
  }

  /**
   * A **jump** take-off (t12b): a short upward whoosh of band-passed noise (the
   * air of the leap) layered with a brief low triangle "grunt" of effort. Driven
   * off the server `'jump'` event, positioned at the jumper.
   */
  jump(pos: Point3): void {
    // Real sample if present; otherwise the synth whoosh + grunt below.
    if (this.playBuffer('jump', pos, { rate: 0.96 + Math.random() * 0.08 })) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      // Whoosh: a band of noise sweeping upward as the body launches.
      const air = ctx.createBufferSource();
      air.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.9;
      bp.frequency.setValueAtTime(300, t0);
      bp.frequency.exponentialRampToValueAtTime(1300, t0 + 0.16);
      const airEnv = this.env(ctx, t0, 0.02, 0.16, 0.28);
      air.connect(bp).connect(airEnv).connect(dest);
      air.start(t0, Math.random() * 0.5);
      air.stop(t0 + 0.2);

      // Grunt: a short low triangle blip for the effort of the leap.
      const grunt = ctx.createOscillator();
      grunt.type = 'triangle';
      grunt.frequency.setValueAtTime(180, t0);
      grunt.frequency.exponentialRampToValueAtTime(120, t0 + 0.12);
      const gruntEnv = this.env(ctx, t0, 0.01, 0.13, 0.3);
      grunt.connect(gruntEnv).connect(dest);
      grunt.start(t0);
      grunt.stop(t0 + 0.16);
      return [air, grunt];
    });
  }

  /**
   * A **landing** thud (t12b): a low sine that snaps down (the weight hitting
   * the ground) under a soft low band of noise (the scuff of contact). Fired
   * when an entity leaves the `'jump'` state; positioned at the lander.
   */
  land(pos: Point3): void {
    // Real sample if present; otherwise the synth thud below.
    if (this.playBuffer('land', pos)) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      // Body: a low sine snapping downward — the mass touching down.
      const body = ctx.createOscillator();
      body.type = 'sine';
      body.frequency.setValueAtTime(120, t0);
      body.frequency.exponentialRampToValueAtTime(48, t0 + 0.11);
      const bodyEnv = this.env(ctx, t0, 0.003, 0.14, 0.6);
      body.connect(bodyEnv).connect(dest);
      body.start(t0);
      body.stop(t0 + 0.18);

      // Scuff: a low band of noise for the grit of the ground contact.
      const scuff = ctx.createBufferSource();
      scuff.buffer = this.noiseBuffer;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      const scuffEnv = this.env(ctx, t0, 0.003, 0.1, 0.34);
      scuff.connect(lp).connect(scuffEnv).connect(dest);
      scuff.start(t0, Math.random() * 0.5);
      scuff.stop(t0 + 0.12);
      return [body, scuff];
    });
  }

  /**
   * A zombie **idle groan** (t12b): a guttural, wavering moan — two detuned
   * sawtooth voices whose pitch sags then lifts, shaped by a slow "vocal tract"
   * band-pass that opens and closes. Deliberately low + soft so a horde of them,
   * throttled by the caller's scheduler, murmurs rather than clips. Positional.
   */
  zombieGroan(pos: Point3): void {
    if (this.playBuffer('zombie_groan', pos, { rate: 0.92 + Math.random() * 0.16 })) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      const dur = 0.7 + Math.random() * 0.5;
      const base = 70 + Math.random() * 30; // a low guttural fundamental
      // A fundamental that sags away then partly recovers — a moan.
      const voice = ctx.createOscillator();
      voice.type = 'sawtooth';
      voice.frequency.setValueAtTime(base, t0);
      voice.frequency.linearRampToValueAtTime(base * 0.82, t0 + dur * 0.5);
      voice.frequency.linearRampToValueAtTime(base * 0.92, t0 + dur);
      // A slightly detuned twin for a rough, inhuman beat.
      const voice2 = ctx.createOscillator();
      voice2.type = 'sawtooth';
      voice2.frequency.setValueAtTime(base * 1.01, t0);
      voice2.frequency.linearRampToValueAtTime(base * 0.83, t0 + dur * 0.5);
      // A vocal-tract-ish band-pass "formant" that opens then closes.
      const formant = ctx.createBiquadFilter();
      formant.type = 'bandpass';
      formant.Q.value = 3.5;
      formant.frequency.setValueAtTime(320, t0);
      formant.frequency.linearRampToValueAtTime(560, t0 + dur * 0.6);
      formant.frequency.linearRampToValueAtTime(280, t0 + dur);
      const env = this.env(ctx, t0, 0.12, dur, 0.3);
      voice.connect(formant);
      voice2.connect(formant);
      formant.connect(env).connect(dest);
      const stop = t0 + 0.12 + dur + 0.05;
      voice.start(t0);
      voice.stop(stop);
      voice2.start(t0);
      voice2.stop(stop);
      return [voice, voice2];
    });
  }

  /**
   * A zombie **aggro snarl** (t12b): brighter + shorter than the groan — a
   * sawtooth growl that spikes up then tears down through a sweeping band-pass,
   * with a ragged noise rasp for the wet edge. The louder, angrier voice; still
   * kept to a modest peak. Positional.
   */
  zombieSnarl(pos: Point3): void {
    if (this.playBuffer('zombie_snarl', pos, { rate: 0.94 + Math.random() * 0.12 })) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      const dur = 0.42 + Math.random() * 0.2;
      const base = 130 + Math.random() * 50;
      // A snapping growl: pitch spikes up, then tears down.
      const growl = ctx.createOscillator();
      growl.type = 'sawtooth';
      growl.frequency.setValueAtTime(base, t0);
      growl.frequency.exponentialRampToValueAtTime(base * 1.5, t0 + 0.05);
      growl.frequency.exponentialRampToValueAtTime(base * 0.6, t0 + dur);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 2.2;
      bp.frequency.setValueAtTime(700, t0);
      bp.frequency.exponentialRampToValueAtTime(1500, t0 + 0.08);
      bp.frequency.exponentialRampToValueAtTime(500, t0 + dur);
      const growlEnv = this.env(ctx, t0, 0.01, dur, 0.4);
      growl.connect(bp).connect(growlEnv).connect(dest);
      growl.start(t0);
      growl.stop(t0 + dur + 0.05);

      // A band of noise for the ragged, wet edge of the snarl.
      const rasp = ctx.createBufferSource();
      rasp.buffer = this.noiseBuffer;
      const rbp = ctx.createBiquadFilter();
      rbp.type = 'bandpass';
      rbp.Q.value = 1.0;
      rbp.frequency.setValueAtTime(900, t0);
      rbp.frequency.exponentialRampToValueAtTime(2200, t0 + 0.1);
      const raspEnv = this.env(ctx, t0, 0.008, dur * 0.8, 0.2);
      rasp.connect(rbp).connect(raspEnv).connect(dest);
      rasp.start(t0, Math.random() * 0.5);
      rasp.stop(t0 + dur);
      return [growl, rasp];
    });
  }

  /**
   * A zombie **claw swipe** (t12b): a fast, high band of noise raking upward
   * then falling — sharper and quicker than the bat {@link swing}. Used for a
   * zombie's `'attack'` (versus the human bat whoosh). Positioned at the attacker.
   */
  zombieClaw(pos: Point3): void {
    if (this.playBuffer('zombie_claw', pos, { rate: 0.95 + Math.random() * 0.1 })) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      const swipe = ctx.createBufferSource();
      swipe.buffer = this.noiseBuffer;
      swipe.playbackRate.value = 1.3;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.6;
      bp.frequency.setValueAtTime(1800, t0);
      bp.frequency.exponentialRampToValueAtTime(3600, t0 + 0.06);
      bp.frequency.exponentialRampToValueAtTime(1200, t0 + 0.14);
      const env = this.env(ctx, t0, 0.006, 0.14, 0.34);
      swipe.connect(bp).connect(env).connect(dest);
      swipe.start(t0, Math.random() * 0.5);
      swipe.stop(t0 + 0.16);
      return [swipe];
    });
  }

  /**
   * A **round-start horn** (t12b): a two-note rising fanfare (root → a fifth
   * above), each note two detuned sawtooths fattened together and softened by a
   * low-pass — a brass swell. Non-positional in practice (emitted at the
   * listener so it reads centred). Driven off the `'roundStart'` event.
   */
  roundStart(pos: Point3): void {
    if (this.playBuffer('round_start', pos)) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1600;
      lp.Q.value = 0.7;
      lp.connect(dest);
      // G3 then a fifth up to D4, the second held — a rising call.
      const notes = [
        { f: 196, at: 0.0, dur: 0.34 },
        { f: 294, at: 0.28, dur: 0.5 },
      ];
      const oscs: AudioScheduledSourceNode[] = [];
      for (const n of notes) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = n.f;
        const osc2 = ctx.createOscillator();
        osc2.type = 'sawtooth';
        osc2.frequency.value = n.f * 1.006; // slight detune → a fatter horn
        const env = this.env(ctx, t0 + n.at, 0.03, n.dur, 0.5);
        osc.connect(env);
        osc2.connect(env);
        env.connect(lp);
        osc.start(t0 + n.at);
        osc.stop(t0 + n.at + n.dur + 0.05);
        osc2.start(t0 + n.at);
        osc2.stop(t0 + n.at + n.dur + 0.05);
        oscs.push(osc, osc2);
      }
      return oscs;
    });
  }

  /**
   * A **round-end sting** (t12b), varied by `winner`: a human win is a bright
   * triangle major triad that lifts and resolves; a zombie win (or unknown) is a
   * darker sawtooth minor cluster, low-passed, that sags and sinks. Non-positional
   * in practice (emitted at the listener). Driven off the `'roundEnd'` event.
   */
  roundEnd(pos: Point3, winner?: 'human' | 'zombie'): void {
    const name =
      winner === 'zombie' ? 'round_end_zombie' : winner === 'human' ? 'round_end_human' : 'round_end';
    if (this.playBuffer(name, pos)) return;
    const humanWin = winner === 'human';
    this.oneShot(pos, (ctx, t0, dest) => {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = humanWin ? 1800 : 900;
      lp.connect(dest);
      // Human: a C major triad that lifts. Otherwise: a low minor cluster that sinks.
      const roots = humanWin ? [262, 330, 392] : [220, 233, 175];
      const oscs: AudioScheduledSourceNode[] = [];
      for (let i = 0; i < roots.length; i += 1) {
        const f = roots[i];
        const osc = ctx.createOscillator();
        osc.type = humanWin ? 'triangle' : 'sawtooth';
        osc.frequency.setValueAtTime(f, t0);
        osc.frequency.exponentialRampToValueAtTime(humanWin ? f * 1.06 : f * 0.85, t0 + 0.9);
        const env = this.env(ctx, t0 + i * 0.04, 0.04, 0.95, 0.34);
        osc.connect(env).connect(lp);
        osc.start(t0 + i * 0.04);
        osc.stop(t0 + 1.0);
        oscs.push(osc);
      }
      return oscs;
    });
  }

  /**
   * A **lobby-ready blip** (t12b): a clean two-step square-wave chirp (low →
   * high), a friendly UI confirm when a player readies up. Non-positional in
   * practice (emitted at the listener / origin so it reads centred).
   */
  lobbyReady(pos: Point3): void {
    if (this.playBuffer('lobby_ready', pos)) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      const steps = [
        { f: 660, at: 0.0 },
        { f: 990, at: 0.09 },
      ];
      const oscs: AudioScheduledSourceNode[] = [];
      for (const st of steps) {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = st.f;
        const env = this.env(ctx, t0 + st.at, 0.005, 0.08, 0.22);
        osc.connect(env).connect(dest);
        osc.start(t0 + st.at);
        osc.stop(t0 + st.at + 0.1);
        oscs.push(osc);
      }
      return oscs;
    });
  }

  /* ---- One-shot plumbing ------------------------------------------------ */

  /**
   * Shared spine for every positional one-shot. Projects `pos` against the
   * listener; if it is within earshot, builds a throwaway `panner → distance
   * gain → SFX bus` tail, lets `build` synthesize the voice into that tail (it
   * owns starting/stopping its sources), and disposes the tail once the voice
   * ends. No-ops when the context is missing/suspended or the source is culled.
   */
  private oneShot(
    pos: Point3,
    build: (ctx: AudioContext, t0: number, dest: AudioNode) => AudioScheduledSourceNode[],
  ): void {
    const ctx = this.ctx;
    if (ctx === null || ctx.state !== 'running' || this.sfxGain === null) return;

    const s = this.spatial(pos);
    if (s === null) return; // beyond MAX_AUDIBLE — never synthesized.

    const t0 = ctx.currentTime;
    const panner = ctx.createStereoPanner();
    panner.pan.value = s.pan;
    const distance = ctx.createGain();
    distance.gain.value = s.gain;
    panner.connect(distance).connect(this.sfxGain);

    const sources = build(ctx, t0, panner);

    // Tear the tail out of the live graph once the (last) voice ends, so the
    // sub-graph is collected instead of leaking a node per event.
    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      try {
        panner.disconnect();
      } catch {
        /* already detached */
      }
      try {
        distance.disconnect();
      } catch {
        /* already detached */
      }
    };
    for (const src of sources) src.onended = cleanup;
  }

  /**
   * Project a world position into a stereo pan + distance gain relative to the
   * current listener, or `null` if it is beyond {@link MAX_AUDIBLE}. Pan is the
   * sine of the source's bearing in the listener's yaw frame (right = positive),
   * softened to ±0.9 so nothing hard-pans; gain rolls off as `1 / (1 + d/ref)`.
   */
  private spatial(pos: Point3): Spatial | null {
    const dx = pos.x - this.listener.x;
    const dy = pos.y - this.listener.y;
    const dz = pos.z - this.listener.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > MAX_AUDIBLE) return null;

    const gain = 1 / (1 + dist / REF_DIST);

    // Right-hand vector for the listener's facing is (cos y, -sin y); the
    // horizontal bearing's sine (right component / horizontal distance) makes a
    // natural stereo pan that responds as you turn.
    let pan = 0;
    const horiz = Math.hypot(dx, dz);
    if (horiz > 0.001) {
      const rightComp = dx * Math.cos(this.listenerYaw) - dz * Math.sin(this.listenerYaw);
      pan = clamp((rightComp / horiz) * 0.9, -1, 1);
    }

    return { pan, gain };
  }

  /* ---- Synthesis helpers ------------------------------------------------ */

  /**
   * A percussive gain envelope: a fast linear attack to `peak`, then an
   * exponential decay back to near-silence. `peak` is clamped positive so the
   * exponential ramp (which cannot target 0) is always valid.
   */
  private env(
    ctx: AudioContext,
    t0: number,
    attack: number,
    decay: number,
    peak: number,
  ): GainNode {
    const g = ctx.createGain();
    const p = Math.max(peak, 0.0002);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(p, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    return g;
  }

  /** A mono buffer of uniform white noise, used by the filtered-noise voices. */
  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * A mono buffer of brown-ish noise (a leaky integral of white noise): far more
   * low-frequency energy than white, which reads as a low rumble/wind — the
   * right raw material for the dark-town bed.
   */
  private makeBrownNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = clamp(last * 3.5, -1, 1);
    }
    return buf;
  }
}
