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
import type { Lake, Tree, World } from '@crawling-dark/shared';

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
const DEFAULT_MUSIC = 0.55;

/** Fixed level of the looping ambient bed, relative to the master bus. */
const AMBIENT_LEVEL = 0.6;

/* -- Music bed (M12 · t12c): a synth pad/pulse layer with dynamic intensity -- */

/** Calm-layer gain of the minor-pad chord at intensity 0 (before the tense duck). */
const MUSIC_CALM_LEVEL = 0.5;

/** Max gain the dissonant "tense" chord layer reaches at intensity 1. */
const MUSIC_TENSE_LEVEL = 0.55;

/** Max depth of the tremolo pulse (heartbeat) layer at intensity 1. */
const MUSIC_PULSE_LEVEL = 0.28;

/** Shared voicing low-pass cutoff (Hz) at intensity 0 (dark) → 1 (bright/urgent). */
const MUSIC_CUTOFF_CALM = 480;
const MUSIC_CUTOFF_TENSE = 3200;

/** Tremolo pulse rate (Hz) at intensity 0 → 1 (a quickening heartbeat). */
const MUSIC_PULSE_HZ_CALM = 1.1;
const MUSIC_PULSE_HZ_TENSE = 2.8;

/** Smoothing time-constant (s) for intensity ramps — long enough to never jerk. */
const MUSIC_INTENSITY_TAU = 0.8;

/** Detuned minor-pad chord (Hz): the always-present calm bed (A minor, low). */
const MUSIC_CALM_CHORD: readonly number[] = [110.0, 130.81, 164.81, 220.0];

/** Dissonant/higher chord (Hz) gated in by intensity: tritone + cluster + urgency. */
const MUSIC_TENSE_CHORD: readonly number[] = [155.56, 233.08, 329.63];

/** Root (Hz) of the low tremolo pulse tone (the heartbeat). */
const MUSIC_PULSE_ROOT = 110.0;

/** Logical name of an OPTIONAL real music track (registered via loadSamples). */
const MUSIC_TRACK = 'music';

/** Level of the optional real track, when a deployment registers + loads one. */
const MUSIC_TRACK_LEVEL = 0.8;

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
  /** Music sub-bus (the dynamic-intensity bed routes here), scaled by {@link musicVolume}. */
  private musicGain: GainNode | null = null;

  /** Cached white-noise buffer reused by every filtered-noise voice. */
  private noiseBuffer: AudioBuffer | null = null;

  /** Guards {@link startAmbient} so the bed is only ever built once. */
  private ambientStarted = false;
  /** Guards {@link startMusic} so the music bed is only ever built once. */
  private musicStarted = false;

  /* Music-bed nodes captured at {@link startMusic} so {@link setMusicIntensity} can
   * crossfade its layers live. All null until the bed is built (then again after
   * {@link dispose}). */
  /** Internal fade-in gain for the whole music bed (kept apart from the user volume). */
  private musicBedGain: GainNode | null = null;
  /** Shared voicing low-pass whose cutoff brightens with intensity. */
  private musicFilter: BiquadFilterNode | null = null;
  /** Calm minor-pad layer gain (ducks slightly as the tense layer rises). */
  private musicCalmGain: GainNode | null = null;
  /** Dissonant/high "tense" layer gain, gated in by intensity. */
  private musicTenseGain: GainNode | null = null;
  /** Tremolo pulse (heartbeat) depth gain, brought up by intensity. */
  private musicPulseGain: GainNode | null = null;
  /** Tremolo pulse LFO whose rate quickens with intensity. */
  private musicPulseLfo: OscillatorNode | null = null;
  /** Latest intensity in [0, 1]; re-applied whenever the bed (re)starts. */
  private musicIntensity = 0;

  /** Live master volume in [0, 1] (applied through the mute multiplier). */
  private master = DEFAULT_MASTER;
  /** Live SFX volume in [0, 1]. */
  private sfx = DEFAULT_SFX;
  /** Live music-bed volume in [0, 1]. */
  private music = DEFAULT_MUSIC;
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

    const music = ctx.createGain();
    music.connect(master);

    this.ctx = ctx;
    this.masterGain = master;
    this.sfxGain = sfx;
    this.ambientGain = ambient;
    this.musicGain = music;
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
    // Music bed (M12 · t12c): drop the bus + the captured intensity nodes.
    this.musicGain = null;
    this.musicStarted = false;
    this.musicBedGain = null;
    this.musicFilter = null;
    this.musicCalmGain = null;
    this.musicTenseGain = null;
    this.musicPulseGain = null;
    this.musicPulseLfo = null;
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
    // Music bus carries the user's music volume; its fade-in lives on musicBedGain.
    this.musicGain?.gain.setTargetAtTime(this.music, now, Math.max(ramp / 3, 0.001));
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

  /* ---- Music bed (dynamic intensity, M12 · t12c) ------------------------ */

  /** Current music-bed volume in [0, 1]. */
  get musicVolume(): number {
    return this.music;
  }

  /** Set the music-bed volume (clamped to [0, 1]); takes effect immediately. */
  setMusicVolume(v: number): void {
    this.music = clamp(v, 0, 1);
    this.applyGains();
  }

  /**
   * Start the looping **music bed** once the context is running — a thing apart
   * from the wind/drone {@link startAmbient ambient texture}. It is a wholly
   * synthesized, evolving score, built to be reshaped live by
   * {@link setMusicIntensity} and layered so calm and tension crossfade without a
   * seam:
   *
   *  - a **calm** detuned minor pad ({@link MUSIC_CALM_CHORD}) that always plays,
   *  - a **tense** dissonant/high chord ({@link MUSIC_TENSE_CHORD}: a tritone +
   *    cluster + an urgent upper voice) gated in as intensity rises,
   *  - a soft **tremolo pulse** (a heartbeat) whose depth + rate climb with dread,
   *  - a shared low-pass that darkens when calm and brightens when tense.
   *
   * The whole bed swells in over ~3 s via an internal {@link musicBedGain} (the
   * {@link musicGain} bus itself carries the user's music volume), so it never
   * pops on. Built exactly once; safe to call on every gesture.
   *
   * Offline-safe/synth-first: no asset files are required. If a deployment has
   * registered a real track (`loadSamples({ music: '…' })`) and it has loaded, it
   * is looped through the same non-positional bed as an extra layer.
   */
  startMusic(): void {
    const ctx = this.ctx;
    if (ctx === null || this.musicGain === null || this.musicStarted) return;
    this.musicStarted = true;
    const t0 = ctx.currentTime;

    // Internal fade-in gain: swell the whole bed up over ~3 s. Kept separate from
    // the musicGain bus so the user's volume slider stays independent of the swell.
    const bed = ctx.createGain();
    bed.gain.setValueAtTime(0, t0);
    bed.gain.linearRampToValueAtTime(1, t0 + 3);
    bed.connect(this.musicGain);
    this.musicBedGain = bed;

    // Shared voicing low-pass: dark when calm, opened up by intensity.
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = MUSIC_CUTOFF_CALM;
    filter.Q.value = 0.8;
    filter.connect(bed);
    this.musicFilter = filter;

    // The two chord layers feed the shared filter.
    const calm = ctx.createGain();
    calm.gain.value = MUSIC_CALM_LEVEL;
    calm.connect(filter);
    this.musicCalmGain = calm;

    const tense = ctx.createGain();
    tense.gain.value = 0; // silent at intensity 0; setMusicIntensity gates it in.
    tense.connect(filter);
    this.musicTenseGain = tense;

    // Oscillators are started together at t0 so their beats stay phase-coherent.
    const started: OscillatorNode[] = [];

    /**
     * Spin up one detuned sustained voice (osc → fixed gain → `dest`) and queue
     * it for a synchronized start. Local to this method so it never touches the
     * shared one-shot synthesis helpers.
     */
    const voice = (
      freq: number,
      detune: number,
      type: OscillatorType,
      level: number,
      dest: AudioNode,
    ): void => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(dest);
      started.push(osc);
    };

    // Calm minor pad — each chord tone as a ±6-cent detuned pair for width.
    for (const f of MUSIC_CALM_CHORD) {
      voice(f, -6, 'sawtooth', 0.11, calm);
      voice(f, 6, 'sawtooth', 0.11, calm);
    }
    // Tense dissonant/high voices — wider detune for a colder, uneasier beat.
    for (const f of MUSIC_TENSE_CHORD) {
      voice(f, -9, 'sawtooth', 0.1, tense);
      voice(f, 9, 'sawtooth', 0.1, tense);
    }

    // Heartbeat pulse: a low triangle tone, tremolo'd by an LFO, whose overall
    // depth (musicPulseGain) is brought up by intensity.
    const pulseTone = ctx.createOscillator();
    pulseTone.type = 'triangle';
    pulseTone.frequency.value = MUSIC_PULSE_ROOT;
    const pulseTrem = ctx.createGain();
    pulseTrem.gain.value = 0.5; // center of the tremolo swing (rides 0..1 with the LFO)
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0; // intensity-controlled; silent when calm.
    pulseTone.connect(pulseTrem).connect(pulseDepth).connect(filter);
    this.musicPulseGain = pulseDepth;

    const pulseLfo = ctx.createOscillator();
    pulseLfo.type = 'sine';
    pulseLfo.frequency.value = MUSIC_PULSE_HZ_CALM;
    const pulseLfoDepth = ctx.createGain();
    pulseLfoDepth.gain.value = 0.5; // ± swing → pulseTrem gain rides 0..1
    pulseLfo.connect(pulseLfoDepth).connect(pulseTrem.gain);
    this.musicPulseLfo = pulseLfo;
    started.push(pulseTone, pulseLfo);

    // Slow breathing on the shared cutoff so the calm bed never sits still. This
    // is additive to the intensity-driven base cutoff (setMusicIntensity).
    const filtLfo = ctx.createOscillator();
    filtLfo.type = 'sine';
    filtLfo.frequency.value = 0.05;
    const filtLfoGain = ctx.createGain();
    filtLfoGain.gain.value = 80;
    filtLfo.connect(filtLfoGain).connect(filter.frequency);
    started.push(filtLfo);

    // Optional real track (synth-first: inert unless a deployment registered one
    // via loadSamples). Looped through the same non-positional bed → musicGain.
    const track = this.library.get(MUSIC_TRACK);
    if (track !== undefined) {
      const src = ctx.createBufferSource();
      src.buffer = track;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = MUSIC_TRACK_LEVEL;
      src.connect(g).connect(bed);
      src.start(t0);
    }

    for (const osc of started) osc.start(t0);

    // Snap the freshly-built layers to whatever intensity was last requested (0
    // by default) with a tiny time-constant so there is no click.
    this.rampMusicIntensity(t0, 0.05);
  }

  /**
   * Set the musical **intensity** in [0, 1] and crossfade the bed toward it: the
   * dissonant tense chord gates in, the calm pad ducks a touch to make room, the
   * heartbeat pulse deepens + quickens, and the shared low-pass brightens. Every
   * move is an {@link AudioParam.setTargetAtTime} ramp (~{@link MUSIC_INTENSITY_TAU}s
   * time-constant), so calling this each frame simply low-pass-follows the target
   * without a single click. Cheap + safe before {@link startMusic}: the value is
   * remembered and applied when the bed is built.
   */
  setMusicIntensity(x: number): void {
    this.musicIntensity = clamp(x, 0, 1);
    const ctx = this.ctx;
    if (ctx === null || !this.musicStarted) return; // stored; applied on startMusic
    this.rampMusicIntensity(ctx.currentTime, MUSIC_INTENSITY_TAU);
  }

  /**
   * Push {@link musicIntensity} onto the live music-bed nodes, each via a
   * `setTargetAtTime` ramp starting at `when` with time-constant `tau` (seconds).
   * No-ops on any node that is null (bed not built). Shared by {@link startMusic}
   * (a near-instant snap) and {@link setMusicIntensity} (a smooth follow).
   */
  private rampMusicIntensity(when: number, tau: number): void {
    const x = this.musicIntensity;
    const tc = Math.max(tau, 0.001);
    // Tense layer gates in; the calm pad ducks up to 30% to clear space for it.
    this.musicTenseGain?.gain.setTargetAtTime(x * MUSIC_TENSE_LEVEL, when, tc);
    this.musicCalmGain?.gain.setTargetAtTime(MUSIC_CALM_LEVEL * (1 - 0.3 * x), when, tc);
    // Heartbeat pulse deepens and quickens with dread.
    this.musicPulseGain?.gain.setTargetAtTime(x * MUSIC_PULSE_LEVEL, when, tc);
    this.musicPulseLfo?.frequency.setTargetAtTime(
      MUSIC_PULSE_HZ_CALM + (MUSIC_PULSE_HZ_TENSE - MUSIC_PULSE_HZ_CALM) * x,
      when,
      tc,
    );
    // Brighten the shared voicing low-pass as tension climbs.
    this.musicFilter?.frequency.setTargetAtTime(
      MUSIC_CUTOFF_CALM + (MUSIC_CUTOFF_TENSE - MUSIC_CUTOFF_CALM) * x,
      when,
      tc,
    );
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

  /* ---- Environment ambience (M12 · t12d) -------------------------------- */

  /*
   * Occasional, randomized, **positional** environment one-shots layered UNDER
   * the ambient bed + music + SFX: a distant wolf howl or wind gust from an
   * unseen bearing, a wooden creak or leaf-rustle from the perimeter forest, and
   * water lapping at the lake shore. Every voice is a self-contained Web-Audio
   * synth (oscillators / filtered noise) routed through the shared {@link oneShot}
   * spatializer, so it pans + attenuates against the listener and works with NO
   * asset files. Feature-tied voices read the seeded {@link World} (lake circle,
   * forest {@link Tree}s) and only fire when their feature exists AND sits within
   * earshot, so the atmosphere reacts to where the player actually is (leaves by
   * the treeline, laps by the water) without ever crowding the mix — one event
   * fires per randomized {@link nextEnvDelayMs interval}, at a subtle level.
   */

  /** Cadence bounds (ms) between environment one-shots — low density on purpose. */
  private static readonly ENV_MIN_MS = 4000;
  private static readonly ENV_MAX_MS = 9000;
  /** Distance band (m) for the feature-free distant voices; both < MAX_AUDIBLE. */
  private static readonly ENV_FAR_MIN = 24;
  private static readonly ENV_FAR_MAX = 40;

  /** Time accumulated (ms) toward the next scheduled environment event. */
  private envAccumMs = 0;
  /** Randomized delay (ms) until the next event; re-rolled after each fire. */
  private envNextMs = this.nextEnvDelayMs();

  /**
   * Per-frame environment driver: accumulate `dtMs` and, once the randomized
   * interval elapses, fire exactly one positional ambient one-shot chosen from
   * the currently-eligible pool (see {@link emitEnvironment}), then re-roll the
   * next interval. No-ops until the context is actually running, so it never
   * schedules into a suspended graph. Call it every frame with the live
   * {@link World} (may be `null` before the town is generated).
   */
  updateEnvironment(dtMs: number, world: World | null): void {
    const ctx = this.ctx;
    if (ctx === null || ctx.state !== 'running') return;
    this.envAccumMs += dtMs;
    if (this.envAccumMs < this.envNextMs) return;
    this.envAccumMs = 0;
    this.envNextMs = this.nextEnvDelayMs();
    this.emitEnvironment(world);
  }

  /**
   * Assemble the pool of eligible emitters and fire one at random. Feature-tied
   * voices (water lap at the shoreline, leaves + creaks from a forest tree) are
   * only added when their world feature exists AND lands within earshot of the
   * listener, so a picked voice is never silently culled by the spatializer. The
   * two distant, feature-free voices (howl, wind gust) are positioned relative
   * to the listener and are always eligible, so every fire produces sound.
   */
  private emitEnvironment(world: World | null): void {
    const y = this.listener.y;
    const pool: Array<() => void> = [];

    // Water lapping at the lake's edge — a point on the shoreline circle.
    const water = world?.water ?? null;
    if (water !== null) {
      const shore = this.envLakePos(water, y);
      if (this.withinEarshot(shore)) pool.push(() => this.waterLap(shore));
    }

    // Forest rustle / creak — a random nearby perimeter tree, if any is close.
    const trees = world?.trees;
    if (trees !== undefined && trees.length > 0) {
      const near = this.pickAudibleTree(trees, y);
      if (near !== null) {
        pool.push(() => this.leaves(near));
        pool.push(() => this.creak(near));
      }
    }

    // Distant, feature-free atmosphere — always available around the listener.
    pool.push(() => this.howl(this.envDistantPos(y)));
    pool.push(() => this.windGust(this.envDistantPos(y)));

    pool[Math.floor(Math.random() * pool.length)]();
  }

  /** Roll a fresh inter-event delay (ms) uniformly in the cadence band. */
  private nextEnvDelayMs(): number {
    const lo = AudioEngine.ENV_MIN_MS;
    const hi = AudioEngine.ENV_MAX_MS;
    return lo + Math.random() * (hi - lo);
  }

  /**
   * A world position on a random bearing around the listener at a largish (but
   * still audible) distance — for the non-feature distant voices. Emitted at the
   * listener's `y` so panning is purely horizontal.
   */
  private envDistantPos(y: number): Point3 {
    const ang = Math.random() * Math.PI * 2;
    const d =
      AudioEngine.ENV_FAR_MIN +
      Math.random() * (AudioEngine.ENV_FAR_MAX - AudioEngine.ENV_FAR_MIN);
    return {
      x: this.listener.x + Math.cos(ang) * d,
      y,
      z: this.listener.z + Math.sin(ang) * d,
    };
  }

  /**
   * A random point on the lake's shoreline: a random angle around the lake
   * centre at (roughly) the water radius, nudged a little in/out so the lap
   * isn't always dead on the rim. Absolute world-space, so it may be far from
   * the listener — the caller earshot-checks before using it.
   */
  private envLakePos(water: Lake, y: number): Point3 {
    const ang = Math.random() * Math.PI * 2;
    const r = Math.max(0, water.radius + (Math.random() * 1.4 - 0.5));
    return {
      x: water.cx + Math.cos(ang) * r,
      y,
      z: water.cz + Math.sin(ang) * r,
    };
  }

  /**
   * Pick one uniformly-random tree within {@link MAX_AUDIBLE} of the listener,
   * or `null` if none is close (the player is away from the treeline). Uses
   * single-pass reservoir sampling (k = 1) so it needs one XZ distance test per
   * tree and no temporary array — cheap even for the dense perimeter forest.
   */
  private pickAudibleTree(trees: readonly Tree[], y: number): Point3 | null {
    const r2 = MAX_AUDIBLE * MAX_AUDIBLE;
    let chosen: Tree | null = null;
    let seen = 0;
    for (const t of trees) {
      const dx = t.x - this.listener.x;
      const dz = t.z - this.listener.z;
      if (dx * dx + dz * dz > r2) continue;
      seen += 1;
      // Every audible tree gets an equal 1/seen chance of being the survivor.
      if (Math.random() * seen < 1) chosen = t;
    }
    return chosen === null ? null : { x: chosen.x, y, z: chosen.z };
  }

  /** Whether `p` is within {@link MAX_AUDIBLE} of the listener (a 3-D test). */
  private withinEarshot(p: Point3): boolean {
    const dx = p.x - this.listener.x;
    const dy = p.y - this.listener.y;
    const dz = p.z - this.listener.z;
    return dx * dx + dy * dy + dz * dz <= MAX_AUDIBLE * MAX_AUDIBLE;
  }

  /** A random start offset (s) into the cached noise buffer, for grain variety. */
  private noiseOffset(): number {
    const buf = this.noiseBuffer;
    return buf === null ? 0 : Math.random() * buf.duration;
  }

  /**
   * A **distant wolf howl**: a sawtooth that glides up to a held note then falls
   * away, wavered by a gentle vibrato and softened through a resonant low-pass so
   * it reads as far-off and mournful. Slow swell in/out. Optional real sample via
   * `'howl'`; synth fallback otherwise. Positioned by the caller.
   */
  howl(pos: Point3): void {
    if (this.playBuffer('howl', pos, { rate: 0.97 + Math.random() * 0.06 })) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      const dur = 1.3 + Math.random() * 0.6;
      const tEnd = t0 + dur + 0.05;
      const base = 300 + Math.random() * 60;

      // Voice: glide up to the held note, sustain, then droop away.
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base * 0.8, t0);
      osc.frequency.linearRampToValueAtTime(base * 1.5, t0 + dur * 0.35);
      osc.frequency.setValueAtTime(base * 1.5, t0 + dur * 0.7);
      osc.frequency.linearRampToValueAtTime(base * 0.9, tEnd);

      // Vibrato so the held note wavers like a real howl.
      const vib = ctx.createOscillator();
      vib.type = 'sine';
      vib.frequency.value = 5 + Math.random() * 1.5;
      const vibGain = ctx.createGain();
      vibGain.gain.value = base * 0.03;
      vib.connect(vibGain).connect(osc.frequency);

      // Resonant low-pass gives it a soft, vocal, distant colour.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      lp.Q.value = 4;

      const env = this.env(ctx, t0, dur * 0.3, dur * 0.7, 0.32);
      osc.connect(lp).connect(env).connect(dest);

      osc.start(t0);
      osc.stop(tEnd);
      vib.start(t0);
      vib.stop(tEnd);
      return [osc, vib];
    });
  }

  /**
   * A **wind gust**: looping noise through a band-pass that sweeps up then back
   * down as the gust rises and dies, under a slow swell envelope. Optional real
   * sample via `'windGust'`; synth fallback otherwise. Positioned by the caller.
   */
  windGust(pos: Point3): void {
    if (this.playBuffer('windGust', pos)) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      const dur = 1.4 + Math.random() * 1.0;
      const tEnd = t0 + dur + 0.05;

      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true; // gusts outlast the 1.5 s buffer — loop so it never runs dry
      src.playbackRate.value = 0.85 + Math.random() * 0.3;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.8;
      bp.frequency.setValueAtTime(300, t0);
      bp.frequency.linearRampToValueAtTime(1100, t0 + dur * 0.5);
      bp.frequency.linearRampToValueAtTime(280, tEnd);

      const env = this.env(ctx, t0, dur * 0.45, dur * 0.55, 0.26);
      src.connect(bp).connect(env).connect(dest);

      src.start(t0, this.noiseOffset());
      src.stop(tEnd);
      return [src];
    });
  }

  /**
   * A **wooden creak**: a low sawtooth groan whose pitch creeps up under strain,
   * through a woody resonant band-pass, its amplitude stuttered by a fast square
   * tremolo for the stick-slip "creeeak". Optional real sample via `'creak'`;
   * synth fallback otherwise. Positioned by the caller (a forest tree).
   */
  creak(pos: Point3): void {
    if (this.playBuffer('creak', pos)) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      const dur = 0.5 + Math.random() * 0.4;
      const tEnd = t0 + dur + 0.05;
      const f = 90 + Math.random() * 50;

      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, t0);
      osc.frequency.linearRampToValueAtTime(f * 1.3, tEnd);

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 320;
      bp.Q.value = 6;

      const env = this.env(ctx, t0, 0.06, dur, 0.22);

      // Tremolo: a square LFO drives a gain around 0.55 (±0.45 → 0.10..1.00) so
      // the groan stutters instead of sustaining flatly.
      const trem = ctx.createOscillator();
      trem.type = 'square';
      trem.frequency.value = 18 + Math.random() * 14;
      const tremGain = ctx.createGain();
      tremGain.gain.value = 0.45;
      const mod = ctx.createGain();
      mod.gain.value = 0.55;
      trem.connect(tremGain).connect(mod.gain);

      osc.connect(bp).connect(env).connect(mod).connect(dest);

      osc.start(t0);
      osc.stop(tEnd);
      trem.start(t0);
      trem.stop(tEnd);
      return [osc, trem];
    });
  }

  /**
   * **Water lapping** at the shore: soft low-passed noise (the cutoff falling as
   * the wavelet settles) shaped into two quick swells — the "lap-lap" of a small
   * wave. Optional real sample via `'waterLap'`; synth fallback otherwise.
   * Positioned by the caller (a point on the lake shoreline).
   */
  waterLap(pos: Point3): void {
    if (this.playBuffer('waterLap', pos)) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      const dur = 0.5 + Math.random() * 0.3;
      const tEnd = t0 + dur + 0.05;

      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      src.playbackRate.value = 0.9 + Math.random() * 0.3;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.9;
      lp.frequency.setValueAtTime(1400, t0);
      lp.frequency.exponentialRampToValueAtTime(500, tEnd);

      // Two-bump envelope → the gentle double lap of a wavelet meeting the bank.
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(0.2, t0 + 0.05);
      env.gain.exponentialRampToValueAtTime(0.06, t0 + dur * 0.45);
      env.gain.linearRampToValueAtTime(0.16, t0 + dur * 0.6);
      env.gain.exponentialRampToValueAtTime(0.0001, tEnd);

      src.connect(lp).connect(env).connect(dest);
      src.start(t0, this.noiseOffset());
      src.stop(tEnd);
      return [src];
    });
  }

  /**
   * **Rustling leaves**: dry high-passed noise with a mid-rate sine flutter so it
   * shivers like wind through the canopy. Short and soft. Optional real sample
   * via `'leaves'`; synth fallback otherwise. Positioned by the caller (a tree).
   */
  leaves(pos: Point3): void {
    if (this.playBuffer('leaves', pos)) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      const dur = 0.4 + Math.random() * 0.4;
      const tEnd = t0 + dur + 0.05;

      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      src.playbackRate.value = 1.0 + Math.random() * 0.4;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2000;
      hp.Q.value = 0.6;

      const env = this.env(ctx, t0, 0.08, dur, 0.16);

      // Flutter: a sine LFO drives a gain around 0.6 (±0.4) for the shimmer.
      const flut = ctx.createOscillator();
      flut.type = 'sine';
      flut.frequency.value = 9 + Math.random() * 6;
      const flutGain = ctx.createGain();
      flutGain.gain.value = 0.4;
      const mod = ctx.createGain();
      mod.gain.value = 0.6;
      flut.connect(flutGain).connect(mod.gain);

      src.connect(hp).connect(env).connect(mod).connect(dest);

      src.start(t0, this.noiseOffset());
      src.stop(tEnd);
      flut.start(t0);
      flut.stop(tEnd);
      return [src, flut];
    });
  }
}
