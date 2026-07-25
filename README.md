# The Crawling Dark

A multiplayer, third-person survival game built with **Three.js** on the client and an
**authoritative Node + `ws`** server. Players spawn in a dark town; one zombie NPC hunts
them. Survive the 5-minute round as a human to win — get caught and you rise again as a
zombie. See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design.

## Monorepo layout

This is a [pnpm workspace](https://pnpm.io/workspaces):

| Package                   | Path        | Role                                              |
| ------------------------- | ----------- | ------------------------------------------------- |
| `@crawling-dark/shared`   | `shared/`   | Types, constants, and simulation shared by both sides |
| `@crawling-dark/client`   | `client/`   | Vite + Three.js browser client                    |
| `@crawling-dark/server`   | `server/`   | Authoritative `ws` game server                    |

Both `client` and `server` import from `@crawling-dark/shared`, so tunables like the tick
rate, move speeds, map size, and round length live in exactly one place
(`shared/src/constants.ts`).

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9 (`corepack enable pnpm` or `npm i -g pnpm`)

## Getting started

```bash
pnpm install      # install all workspace dependencies
pnpm dev          # run client (Vite) and server (ws) together
```

Then open the client URL that Vite prints (default http://localhost:5173).

## Useful commands

| Command             | What it does                                              |
| ------------------- | -------------------------------------------------------- |
| `pnpm dev`          | Run client + server concurrently                         |
| `pnpm dev:client`   | Run only the Vite client                                 |
| `pnpm dev:server`   | Run only the `ws` server                                 |
| `pnpm build`        | Build/type-check every package                           |
| `pnpm typecheck`    | Type-check every package                                 |

## Milestones

Development is tracked as milestones on GitHub. **M0 → M7** build the playable game
(scaffold, networking, movement, combat/infection, AI, round loop, prediction, netcode);
**M8 → M17** are the Phase 2 polish batches (movement feel, world/environment, textures,
sky/lighting, audio, characters, VFX/post-processing, the HUD & UX layer — a radar
minimap, a Tab scoreboard, a persisted settings menu, and a combat reticle — the
M16 Menus & Onboarding pass: a title/start screen, a `H`/`?` controls reference,
an `Esc` pause menu, and the kill/turn feed as its own module — and, in M17, a
Round Presentation & Accessibility pass: a round-start role reveal, a "you have
been turned" moment overlay, a full end-of-round results screen, and a
reduced-motion accessibility toggle).
M0 (the scaffold) proves the toolchain end-to-end: a pnpm monorepo, a Vite + Three.js
client rendering a lit ground plane, a `ws` server logging connections, and a `shared/`
package both sides consume.
