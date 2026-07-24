# Audio — attribution & pipeline (M12)

The Crawling Dark's sound is driven by `client/src/audio/AudioEngine.ts` with the
sample loader in `client/src/audio/AssetLibrary.ts` (M12 · t12a).

## Two layers: procedural synth + real samples

Historically the game shipped **no audio files** — every sound was synthesized at
runtime with the Web Audio API (oscillators + filtered noise). That synth core is
still here and is the **offline-safe fallback**: if a sample file is missing,
blocked, or removed from the build, the matching one-shot degrades to its
synthesized voice and the game keeps making sound.

On top of that, t12a adds a **sample path**: `AssetLibrary.load()` `fetch`es +
`decodeAudioData`s a manifest of files under this directory into reusable
`AudioBuffer`s, and `AudioEngine.playBuffer(name, pos)` plays them positionally
through the same spatializer (stereo panner + distance gain + SFX bus) the synth
one-shots use. Any name whose file fails to load simply stays on the synth.

## What ships today: procedural, CC0 by construction

To keep the repo self-contained and offline (no network fetch of binaries), the
sample set shipped here is **baked by our own code** and is therefore
**CC0 / public-domain** — nothing to attribute, nothing to download:

| File | Logical name | Baked by | License |
| ---- | ------------ | -------- | ------- |
| `sfx/footstep.wav` | `footstep` | `scripts/gen-audio-samples.mjs` | CC0 |
| `sfx/impact.wav`   | `hit`      | `scripts/gen-audio-samples.mjs` | CC0 |
| `sfx/swing.wav`    | `swing`    | `scripts/gen-audio-samples.mjs` | CC0 |

Regenerate them anytime with:

```
node scripts/gen-audio-samples.mjs
```

Note `infect` intentionally ships **no** file, so it exercises the missing-asset
→ synth fallback path out of the box.

## Dropping in a curated CC0 recording set

To upgrade a baked placeholder with a real recording, drop a file over it (same
name) or register a new one — no code change to the loader is needed. The engine
exposes `loadSamples({ name: 'audio/…​/file.wav' })` for later tasks (expanded SFX,
music beds, environment one-shots) to register their own files incrementally.

Recommended license-clean sources (all **CC0**) — record each pack's name + URL
here when you commit its files:

- **freesound.org** — https://freesound.org (filter to the CC0 license)
- **Kenney** — https://kenney.nl/assets?q=audio (CC0)
- **Sonniss GDC Game Audio Bundle** — https://sonniss.com/gameaudiogdc (royalty-free)
- **OpenGameArt** — https://opengameart.org (filter to CC0)

| File(s) | Source pack | URL | License |
| ------- | ----------- | --- | ------- |
| _(none yet — procedural placeholders)_ | — | — | CC0 |

## Format & loudness notes

- Keep samples **mono** (the panner spatializes them) and short for one-shots.
- WAV/PCM decodes everywhere; `.ogg`/`.mp3` are smaller if you add many/long
  files (both decode via `decodeAudioData`).
- Bake/normalize one-shots to roughly the level of the synth voices so the
  fallback swap isn't a volume jump; the mix pass (t12e) balances the buses.
