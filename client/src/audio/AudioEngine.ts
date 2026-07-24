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
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.playbackRate.value = 1.1;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(400, t0);
      bp.frequency.exponentialRampToValueAtTime(1800, t0 + 0.09);
      bp.frequency.exponentialRampToValueAtTime(500, t0 + 0.24);

      const env = this.env(ctx, t0, 0.02, 0.22, 0.5);
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
   */
  footstep(pos: Point3, kind: FootstepKind): void {
    const p = FOOTSTEP[kind];
    // Real sample if present (t12a): reuse the per-kind rate + relative level;
    // otherwise fall through to the synthesized thud below.
    const rate = p.rate * (0.94 + Math.random() * 0.12);
    if (this.playBuffer('footstep', pos, { rate, gain: p.peak / 0.85 })) return;
    this.oneShot(pos, (ctx, t0, dest) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.playbackRate.value = p.rate * (0.94 + Math.random() * 0.12);

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = p.freq * (0.9 + Math.random() * 0.2);
      lp.Q.value = 0.9;

      const env = this.env(ctx, t0, 0.004, p.dur, p.peak * (0.85 + Math.random() * 0.3));
      src.connect(lp).connect(env).connect(dest);

      // A random offset into the noise gives each step a distinct grain.
      const buf = this.noiseBuffer;
      const off = buf ? Math.random() * Math.max(0, buf.duration - p.dur - 0.02) : 0;
      src.start(t0, off);
      src.stop(t0 + p.dur + 0.02);
      return [src];
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
