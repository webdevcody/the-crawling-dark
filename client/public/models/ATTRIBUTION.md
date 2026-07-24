# Character models — attribution & pipeline (M13)

The Crawling Dark's entity bodies are rendered behind the `CharacterModel` seam
in `client/src/entities/Character.ts`. Two implementations honor that seam:

- **`Character`** — the procedural articulated box-rig (M6 · t6c). The
  **offline-safe default** with zero asset dependency.
- **`GltfCharacter`** (M13 · t13a) — loads a rigged `.glb`, clones it per body
  (`SkeletonUtils`), and drives a per-instance `AnimationMixer` whose clips are
  **named by entity state**.

Which one runs is a single switch in `client/src/main.ts`
(`CHARACTER_RENDERER: 'procedural' | 'gltf'`). **As of M13 t13b/t13c the default
is `'gltf'`**, rendering the baked `human.glb` / `zombie.glb` below (with the
per-body procedural fallback intact). Because the heavy `GLTFLoader` is imported
**dynamically**, setting the switch back to `'procedural'` keeps the loader out
of the main bundle entirely (a byte-identical, zero-asset build).

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

To keep the repo self-contained and offline (no network fetch of binaries), every
model shipped here is **baked by our own code** and is therefore **CC0 /
public-domain** — nothing to attribute, nothing to download:

| File | Baked by | License | Role |
| ---- | -------- | ------- | ---- |
| `human.glb` | `scripts/gen-human-glb.mjs` | CC0 | **shipped** — the human body (t13b): upright, tapered limbs + rounded head, holds a baseball bat |
| `zombie.glb` | `scripts/gen-zombie-glb.mjs` | CC0 | **shipped** — the zombie body (t13c): hunched, gaunt, asymmetric arms + lolling head; model-swaps on infection |
| `character.glb` | `scripts/gen-character-glb.mjs` | CC0 | pipeline test fixture (the original t13a box-man) |

`human.glb` / `zombie.glb` are the models the `'gltf'` renderer loads today —
distinct silhouettes and per-state clips, not final AAA art but a real upgrade
over the box-man and each other. `character.glb` remains as the minimal
fixture that **exercises + verifies** the seam. Regenerate any of them:

```
node scripts/gen-human-glb.mjs
node scripts/gen-zombie-glb.mjs
node scripts/gen-character-glb.mjs
```

Verify each (headless load → clone → mixer, asserting the clip/node contract):

```
node scripts/verify-human-glb.mjs
node scripts/verify-zombie-glb.mjs
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
| `human.glb` | baked by `scripts/gen-human-glb.mjs` (t13b) | — (authored in-repo) | CC0 |
| `zombie.glb` | baked by `scripts/gen-zombie-glb.mjs` (t13c) | — (authored in-repo) | CC0 |

To swap in externally-authored art instead, drop a real `.glb` over `human.glb`
/ `zombie.glb` (keep the clip names + Y-up feet-at-origin rig) and record its
pack + URL above — **no loader code changes**.

## Notes

- Prefer **glTF Binary (`.glb`)** — one file, no sidecar `.bin`/textures.
- Keep rigs modest (a few thousand tris) — a full horde is on screen at once.
- If a heavy model set is added, wire a `DRACOLoader`/`KTX2Loader` in
  `GltfCharacter.loadAsset()`; the public seam does not change.
