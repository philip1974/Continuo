# Contributing to Continuo

Continuo is MIT-licensed and welcomes outside contributions. Bug reports, plugin authors, and substrate PRs all land in the same place.

## Prereqs

- **Node 24** (see `.nvmrc` and `engines.node` in `package.json`)
- **pnpm** (the only supported package manager — `pnpm-lock.yaml` is the lockfile)
- macOS / Linux / Windows all build (`node-pty` + Electron require `electron-rebuild` after first install on some hosts: `pnpm rebuild:native`)

## Build / Dev / Test

```bash
# install deps
pnpm install

# run dev (electron-vite watches main + preload + renderer)
pnpm dev

# typecheck (4 tsconfigs: node / web / test / e2e)
pnpm typecheck

# lint
pnpm lint

# vitest workspace — three projects: unit / integration / contract
pnpm test                   # all three
pnpm test:unit
pnpm test:integration
pnpm test:contract

# end-to-end (Playwright, separate from vitest)
pnpm e2e
pnpm test:smoke             # quick Playwright smoke only

# production app bundle (macOS)
pnpm build:app
```

## PR flow

1. Fork → branch from `main`.
2. Keep changes scoped — one logical concern per PR.
3. Add or update tests:
   - **BDD specs** (cross-module observable behavior) live in `src/__tests__/<topic>/` with a `README.md` + `*.spec.ts`. Run `pnpm bdd:index` after adding/removing/renaming.
   - **TDD unit tests** live next to the module under `src/**/*.spec.ts`.
   - See `CLAUDE.md` for the BDD+TDD development rules this repo enforces.
4. `pnpm typecheck && pnpm lint && pnpm test` must pass locally before opening PR.
5. CI (`.github/workflows/ci.yml`, `e2e.yml`) runs the same checks; PRs cannot merge with a red CI.
6. Use Conventional Commits-style messages (`feat:`, `fix:`, `chore:`, `test:`, `refactor:`, `docs:`).

## Writing a plugin

Start here:

- `examples/sample-plugin/` — minimal manifest + main.js
- `examples/mcp-demo-plugin/` — plugin that registers MCP tools
- `src/plugins/README.md` — Plugin SDK overview (12 contribution points, disposable LIFO model, manifest schema, permission keys)

The plugin SDK speaks **CoApp** (a scoped facade over `window.api`), not `window.api` directly — this is intentional for cross-project reuse.

## Design system constraints (read before touching UI)

`CLAUDE.md` carries the hard rules. Short version:

- Never use raw Tailwind colors (`bg-neutral-*`, `bg-sky-*`, literal hex). Use semantic tokens (`bg-canvas`, `bg-panel`, `text-fg`, `border-line`, `accent`) defined in `src/styles/theme.css`.
- Reuse `@/design` components (`Button`, `IconButton`, `Modal`, `Input`, …) instead of writing raw `<button>` / `<input>` className.
- `src/styles/nous-tokens.css` is a verbatim copy from upstream Nous — never modify.

## Deep design references

This repo intentionally keeps `doc/` thin (just ADRs). Architecture history, design tutorials, and verified source-card cross-refs live in a **separate ContinuoWiki repo** (read-only relative to this codebase). Look there if you want to know *why* a decision was made; look in code and ADRs if you want to know *what* the decision is today.

## Questions / Issues

Open an issue at <https://github.com/philip1974/Continuo/issues>. For security-sensitive reports please email the maintainer rather than filing a public issue.
