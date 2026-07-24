# Character models — attribution & pipeline (M13)

The Crawling Dark's entity bodies are rendered behind the `CharacterModel` seam
in `client/src/entities/Character.ts`. Two implementations honor that seam:

- **`Character`** — the procedural articulated box-rig (M6 · t6c). The
  **offline-safe default** with zero asset dependency.
- **`GltfCharacter`** (M13 · t13a) — loads a rigged `.glb`, clones it per body
  (`SkeletonUtils`), and drives a per-instance `AnimationMixer` whose clips are
  **named by entity state**.

Which one runs is a single switch in `client/src/main.ts`
(`CHARACTER_RENDERER: 'procedural' | 'gltf'`). Because the heavy `GLTFLoader` is
imported **dynamically**, leaving it on `'procedural'` keeps the loader out of
the main bundle entirely (the default build is byte-identical to before).

## Graceful fallback (same philosophy as audio/textures)

Like the audio (`AudioEngine.ts`) and texture (`TextureLibrary.ts`) passes,
`GltfCharacter` is **procedural-first and offline-safe**: each body starts as a
procedural `Character` stand-in and only swaps to the rigged model once the
shared `.glb` has loaded. If the asset is missing, blocked, or fails to decode,
the body simply **keeps its procedural rig** — the game never renders nothing.

## The clip-naming contract (important)

`GltfCharacter` cross-fades to the animation clip whose **name matches the
entity state**. A dropped-in `.glb` MUST name its clips (case-insensitive):

| Clip name | Driven by `EntityState` |
| --------- | ----------------------- |
| `idle`    | `idle` |
| `walk`    | `walk` |
| `run`     | `run` |
| `crawl`   | `crawl` |
| `jump`    | `jump` |
| `swing`   | `attack` **(human)** — a bat swing |
| `claw`    | `attack` **(zombie)** — a claw rake |
| `stun`    | `stun` |
| `down`    | `down` |

A missing clip falls back to `idle` (then to the first clip), so a partial set
still renders. Orientation/scale: **Y-up, feet at the origin**, ~1.8 m tall,
facing **-Z** (the sim/camera yaw convention). The team recolor tints each
body's material `color` (+ a self-glow `emissive` for the local player), so a
single model serves both teams; a distinct `zombie` URL model-swaps on infection.

## What ships today: procedural, CC0 by construction

To keep the repo self-contained and offline (no network fetch of binaries), the
model shipped here is **baked by our own code** and is therefore **CC0 /
public-domain** — nothing to attribute, nothing to download:

| File | Baked by | License |
| ---- | -------- | ------- |
| `character.glb` | `scripts/gen-character-glb.mjs` | CC0 |

`character.glb` is a jointed box-man (torso + head + two arms + two legs) sized
to the procedural rig's proportions, with one looping clip per state above. It
exists to **exercise + verify** the pipeline, not as final art — flip the switch
to `'gltf'` to see it render/animate. Regenerate anytime with:

```
node scripts/gen-character-glb.mjs
```

Verify it (headless load → clone → mixer, asserting the clip/node contract):

```
node scripts/verify-character-glb.mjs
```

## Dropping in real rigged models (t13b / t13c)

Drop a real `.glb` over `character.glb` (or add `human`/`zombie` URLs in
`main.ts`) — **no loader code changes**. Keep the clip names above; keep the
rig Y-up with feet at the origin. Recommended license-clean sources (all **CC0**),
record each pack's name + URL here when you commit its files:

- **Quaternius** — https://quaternius.com (CC0 rigged/animated characters)
- **Kenney** — https://kenney.nl/assets (CC0)
- **Mixamo** — https://www.mixamo.com (free rigs/anims; export glTF, rename
  clips to the state names above)
- **Poly Pizza** — https://poly.pizza (filter to CC0)

| File(s) | Source pack | URL | License |
| ------- | ----------- | --- | ------- |
| _(none yet — procedural placeholder)_ | — | — | CC0 |

## Notes

- Prefer **glTF Binary (`.glb`)** — one file, no sidecar `.bin`/textures.
- Keep rigs modest (a few thousand tris) — a full horde is on screen at once.
- If a heavy model set is added, wire a `DRACOLoader`/`KTX2Loader` in
  `GltfCharacter.loadAsset()`; the public seam does not change.
