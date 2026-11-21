# Contributing to Continuo

Continuo is MIT-licensed and welcomes outside contributions. Bug reports, plugin authors, and substrate PRs all land in the same place.

## Prereqs

- **Node 24** (see `.nvmrc` and `engines.node` in `package.json`)
- **pnpm 9 or newer** (the only supported package manager — `pnpm-lock.yaml` is the lockfile; CI uses pnpm 9, and installs with pnpm 10–12 have been verified manually)
- The sibling repo [ContinuoTerminal](https://github.com/philip1974/ContinuoTerminal) cloned next to this one and checked out at the commit in `.continuo-terminal-ref` (see the README **Quick start**)
- Only macOS has been run and tested so far; Windows / Linux are untested. `pnpm install` rebuilds `node-pty` for Electron automatically — if that fails, re-run `pnpm rebuild:native`

## Build / Dev / Test

```bash
# install deps
pnpm install

# run dev (electron-vite watches main + preload + renderer)
pnpm dev

# typecheck (node / web / e2e tsconfigs; tests have their own)
pnpm typecheck
pnpm typecheck:test

# lint
pnpm lint

# vitest workspace — four projects: unit / integration / contract / electron
pnpm test                   # all four
pnpm test:unit
pnpm test:integration
pnpm test:contract

# only if you fetched the js-debug adapter (node scripts/fetch-debug-adapter.mjs):
# the real-debugger tests then run too and need their fixture compiled first
pnpm exec tsc -p scripts/debug-spike/tsconfig.json

# end-to-end (Playwright, separate from vitest) — runs the built app, so build first
pnpm build
pnpm e2e
pnpm test:smoke             # quick Playwright smoke only

# production app bundle (current platform; build:app:mac / :win / :linux to pick one)
pnpm build:app
```

`build:app*` automatically runs `pnpm check:secrets:pack` after electron-builder: it scans `out-pack/` and every `app.asar` under `dist-electron/` for GitHub tokens / AWS keys / private keys and fails the build on any hit (printing only file + offset, never the value). Do not publish an installer from a build where this step failed.

The sibling dependency `../ContinuoTerminal` is pinned by commit SHA in `.continuo-terminal-ref` (CI checks out exactly that commit). `build:app*` first runs `pnpm check:sibling-ref`, which aborts unless the local `../ContinuoTerminal` checkout is clean and its HEAD equals the recorded SHA. To bump it, push the new ContinuoTerminal commit, update `.continuo-terminal-ref`, and re-run `pnpm install`.

## PR flow

1. Fork → branch from `main`.
2. Keep changes scoped — one logical concern per PR.
3. Add or update tests:
   - **BDD specs** (cross-module observable behavior) live in `src/__tests__/<topic>/` as `*.spec.ts`, with a `README.md` describing the behavior (expected for new topics; some older topics don't have one yet). Run `pnpm bdd:index` after adding/removing/renaming. The `*.spec.ts` files are the authoritative, executable spec; each topic's `README.md` (mostly in Chinese) is a summary written alongside it and can lag behind the code — if they disagree, trust the spec, and feel free to fix the README.
   - **Unit tests** for renderer code also live under `src/__tests__/`; main-process tests live next to the code under `electron/main/**/__tests__/`.
   - `CLAUDE.md` (in Chinese) holds the maintainer's full development rules. The parts that apply to every contributor are summarized here; the skills and agents it mentions (`/comprehend`, `test-driven-development`, …) are maintainer-local tooling and are not required.
4. `pnpm typecheck && pnpm lint && pnpm test` must pass locally before opening a PR.
5. CI (`.github/workflows/ci.yml`) runs lint and typecheck (Linux), the four vitest projects (Linux and Windows), and a `debug-spike` job that downloads the js-debug adapter and runs the real-debugger tests (Linux) on every pull request. On Windows a set of not-yet-verified specs is excluded (see `vitest.workspace.ts`) and the `electron` project is non-blocking. The `check-no-skip` gate that `pnpm test` runs first is local-only. The maintainer merges pull requests only when CI is green. The Electron end-to-end suite (`e2e.yml`) is run manually by the maintainer.
6. Use Conventional Commits-style messages (`feat:`, `fix:`, `chore:`, `test:`, `refactor:`, `docs:`).

## Writing a plugin

Start here:

- `src/plugins/README.md` — Plugin SDK overview (11 contribution points, disposable LIFO model, a minimal manifest, permission keys); the full manifest schema is `electron/shared/plugin-manifest.ts`
- Real plugins to copy from: [continuo-git-changes-viewer-plugin](https://github.com/philip1974/continuo-git-changes-viewer-plugin), [continuo-skills-manager-plugin](https://github.com/philip1974/continuo-skills-manager-plugin)

Plugins talk to the app only through **CoApp**, a scoped facade over the renderer's IPC API (`coApi`); they never get the raw IPC surface.

## Design system constraints (read before touching UI)

`CLAUDE.md` carries the hard rules. Short version:

- Never use raw Tailwind colors (`bg-neutral-*`, `bg-sky-*`, literal hex). Use semantic tokens (`bg-canvas`, `bg-panel`, `text-fg`, `border-line`, `accent`) defined in `src/styles/theme.css`.
- Reuse `@/design` components (`Button`, `IconButton`, `Modal`, `Input`, …) instead of writing raw `<button>` / `<input>` className.
- `src/styles/nous-tokens.css` and `src/design/` are copied from the maintainer's Nous design system (not public) — never modify the tokens file; Continuo-only tweaks to `src/design/` must be marked as such (see `CLAUDE.md`). `pnpm sync:design` syncs them from that private repo and is maintainer-only.

## Deep design references

The code and the sub-area READMEs are the source of truth. Continuo was previously called **LayoutMotion** ("LM"); that name survives in a few identifiers (e.g. the `minLMVersion` manifest field, the `layoutmotion.theme.mode` storage key) and in older issues. Some code comments and READMEs mention `doc/…`, `.claude/dev-loop/…`, or "ContinuoWiki" — those are the maintainer's local notes and are not published; you don't need them to build or contribute.

## Questions / Issues

Open an issue at <https://github.com/philip1974/Continuo/issues>. For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of filing a public issue. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
