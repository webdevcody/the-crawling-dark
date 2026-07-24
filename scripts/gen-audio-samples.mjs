/**
 * The Crawling Dark — placeholder CC0 audio-sample generator (M12 · t12a).
 *
 * This sandbox ships with no recorded audio and has no reliable runtime fetch,
 * yet t12a's asset pipeline (`client/src/audio/AssetLibrary.ts`) needs *real*
 * sample files to exercise its `fetch` + `decodeAudioData` path. Rather than
 * pull binaries off the network, we BAKE a tiny set of short, mono, 16-bit PCM
 * WAVs here — procedural, offline, and CC0 by construction (they are authored
 * entirely by this script). They are deliberately close cousins of the synth
 * voices in `AudioEngine.ts` so swapping between "sample present" and "sample
 * removed -> synth fallback" is seamless.
 *
 * Run with `node scripts/gen-audio-samples.mjs`; it (re)writes the WAVs under
 * `client/public/audio/sfx/`. Drop real CC0 recordings over these to upgrade the
 * mix without touching code — see `client/public/audio/ATTRIBUTION.md`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'client', 'public', 'audio', 'sfx');
const SAMPLE_RATE = 44100;

/** Deterministic PRNG (mulberry32) so regenerated samples are byte-stable. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Encode a Float32 sample array in [-1,1] as a mono 16-bit PCM WAV Buffer. */
function encodeWav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // format = PCM
  buf.writeUInt16LE(1, 22); // channels = mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    const s = clamp(samples[i], -1, 1);
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

/** A percussive attack->exp-decay envelope, mirroring `AudioEngine.env`. */
function env(t, attack, decay, peak) {
  if (t < attack) return (t / attack) * peak;
  const d = t - attack;
  return peak * Math.exp((-5 * d) / decay);
}

/** One-pole low-pass over a sample array (cutoff in Hz). */
function lowpass(samples, cutoff) {
  const dt = 1 / SAMPLE_RATE;
  const rc = 1 / (2 * Math.PI * cutoff);
  const alpha = dt / (rc + dt);
  let y = 0;
  for (let i = 0; i < samples.length; i += 1) {
    y += alpha * (samples[i] - y);
    samples[i] = y;
  }
  return samples;
}

/** A footstep: a short low-passed noise thud with a quick body. */
function footstep() {
  const dur = 0.14;
  const n = Math.floor(SAMPLE_RATE * dur);
  const rnd = rng(1337);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = rnd() * 2 - 1;
  lowpass(out, 900);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    out[i] *= env(t, 0.004, 0.11, 0.85);
  }
  return out;
}

/** A bat impact: a low sine "thock" (190->55 Hz) plus a bright noise click. */
function impact() {
  const dur = 0.2;
  const n = Math.floor(SAMPLE_RATE * dur);
  const rnd = rng(4242);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const f = 190 * Math.exp((Math.log(55 / 190) * t) / 0.12);
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    const body = Math.sin(phase) * env(t, 0.002, 0.17, 0.9);
    const click = (rnd() * 2 - 1) * env(t, 0.001, 0.04, 0.4);
    out[i] = body + click;
  }
  return out;
}

/** A bat swing whoosh: band-passed noise whose energy sweeps up then falls. */
function swing() {
  const dur = 0.26;
  const n = Math.floor(SAMPLE_RATE * dur);
  const rnd = rng(9001);
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i += 1) noise[i] = rnd() * 2 - 1;
  // Cheap band-pass: low-pass the noise, then subtract a slower low-pass to
  // knock out the sub-band, then shape with a swelling envelope.
  const lo = lowpass(noise.slice(), 1800);
  const sub = lowpass(noise.slice(), 350);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    // Swell in, then tail out.
    const swell = Math.sin(Math.PI * clamp(t / dur, 0, 1));
    out[i] = (lo[i] - sub[i]) * swell * 0.9;
  }
  return out;
}

const SAMPLES = { footstep, impact, swing };

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, gen] of Object.entries(SAMPLES)) {
  const wav = encodeWav(gen());
  const path = join(OUT_DIR, `${name}.wav`);
  writeFileSync(path, wav);
  // eslint-disable-next-line no-console
  console.log(`wrote ${path} (${wav.length} bytes)`);
}
