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

Development is tracked as milestones **M0 → M7** on GitHub. M0 (this scaffold) proves the
toolchain end-to-end: a pnpm monorepo, a Vite + Three.js client rendering a lit ground
plane, a `ws` server logging connections, and a `shared/` package both sides consume.
