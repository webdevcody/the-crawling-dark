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
}
