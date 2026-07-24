# Textures — attribution & pipeline (M10)

The Crawling Dark's surface materials (M10 · Textures & Materials) are driven by
`client/src/scene/TextureLibrary.ts`.

## What ships today: procedural, CC0 by construction

Like the audio pass (procedural Web Audio, no bundled assets — see
`client/src/audio/AudioEngine.ts`), the texture pass is **offline-safe and
procedural first**. Every albedo / normal / roughness map used by the game is
**generated at load time by our own code** (seamless fractal value noise painted
to a canvas, an analytic tangent-space normal map from a height field, and a
grayscale roughness field). Because the art is authored entirely by the
generators in this repo, it is **CC0 / public-domain** — there is nothing to
attribute and nothing to download.

This directory therefore ships **no binary texture files**. It exists as the
drop-in point for the optional curated set below.

## Optional: dropping in a curated CC0 photo set

`TextureLibrary.loadPBRSet()` is a real file-loading path with the *same*
graceful fallback (a missing/blocked file resolves to `null` and the material
falls back to its flat base color). To override a procedural default with
photo-scanned art, drop a set under this directory and point a consumer at it,
e.g.:

```
client/public/textures/ground/albedo.jpg
client/public/textures/ground/normal.jpg
client/public/textures/ground/roughness.jpg
```

```ts
const set = await loadPBRSet(
  {
    map: '/textures/ground/albedo.jpg',
    normalMap: '/textures/ground/normal.jpg',
    roughnessMap: '/textures/ground/roughness.jpg',
  },
  groundRepeat,
);
```

Recommended license-clean sources (all **CC0**), if/when a curated set is added
here — record each pack's name + URL in this file when you commit its files:

- **ambientCG** — https://ambientcg.com (CC0)
- **Poly Haven** — https://polyhaven.com/textures (CC0)
- **Kenney** — https://kenney.nl/assets (CC0)

| File(s) | Source pack | URL | License |
| ------- | ----------- | --- | ------- |
| _(none yet — procedural)_ | — | — | CC0 |

## Color space & tiling (important)

three's color management (on by default) requires the correct color space per
map or surfaces look washed out / too dark. The pipeline tags:

- **albedo** → `SRGBColorSpace`
- **normal / roughness** → `NoColorSpace` (linear)

and sets `RepeatWrapping` + max anisotropy on every map. Keep these when adding
curated files (`loadPBRSet` does it for you).

## Later: KTX2 / Basis compression

The procedural maps are small (≤256²) so GPU-compressed textures are unnecessary
today. If a heavy photo set is curated, wire a `KTX2Loader`
(`three/examples/jsm/loaders/KTX2Loader`) + transcoder in `TextureLibrary.ts` and
have `loadPBRSet` prefer a `.ktx2` sibling — the public API does not change.
