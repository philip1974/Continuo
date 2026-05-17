# `src/stores/` — Renderer-side Zustand stores

Global state for the renderer. Each store owns one concern; modules cross-import sparingly (cross-store side effects belong in `useEffect` glue at the consumer, not in store actions).

All stores currently use `import { create } from 'zustand'` (React-coupled). ADR-007 documents a future move to `zustand/vanilla` for clean separation between state logic and React subscriptions; that migration is **not yet implemented**.

## Inventory (8 stores)

| Store | Concern | Persisted? | Truth source |
|---|---|---|---|
| `editor.store.ts` | Open editor tabs (id / filePath / content / dirty), active tab, mode (`edit` / `source` / `preview`) | Not yet (in-memory only) | local |
| `explorer.store.ts` | Active path, expanded paths set, sort (`name` / `mtime` / `ctime` / `size` + reverse), search string | partly (expanded + sort via `explorer.json`) | local |
| `terminal.store.ts` | `TerminalSession[]` mirror (id, title, cwd, originHint `user`/`agent`, agentLabel) + active id | No (PTYs die on restart) | **main** (`terminal-sessions.service.ts` pushes `sessions_changed`) |
| `closing.store.ts` | Set of panel ids currently playing the EXIT animation | No | local — see `dock/wrap-panel-close.ts` |
| `agent-auth.store.ts` | Agent MCP authorization state: one-shot per launch, single pending request enforced, `revoke()` kills all agent terminals | No (intentional — re-prompt each launch) | local; main calls renderer via reverse-IPC |
| `layout-ui.store.ts` | Sidebar open/closed + width (clamped `[200, 500]`px, default 280) | Yes (`explorer.json.layoutUi`) | local |
| `pinned.store.ts` | Ordered list of pinned file paths (Explorer "pinned" section) | Yes (`explorer.json.pinned`) | local |
| `workspace.store.ts` | Workspace root + recent roots LRU (max 5) + `hydrated` flag for the persistence layer | Yes | local; consumers must wait on `hydrated` before reading `root` |

## Why some stores are mirrors and some are local

- **`terminal.store`** is a renderer-side mirror of state owned by the main process. The PTY pool lives in main; the store just shows what main says exists. Renderer never `setSessions` from inside a UI handler — it only flips local UI state (`activeId`). All session create/remove/title-change goes through `coApi.terminal.*` IPC and arrives back as the next `sessions_changed` broadcast.
- **`agent-auth.store`** is local for the *decision*, but the *prompt* is triggered from main via reverse-IPC. Decision is intentionally not persisted: every Continuo launch starts with no granted agent.
- Everything else is renderer-local.

## `hydrated` gate (workspace store)

```
workspace.hydrated === false  → persistence layer hasn't finished reading explorer.json
                              → workspace.root may still be null even if a saved root exists
                              → consumers that race may emit IPC calls with no cwd → main responds
                                with TERMINAL_CWD_UNRESOLVED
```

`initExplorerPersistence` flips `hydrated = true` whether the read succeeds, fails, or finds no file. Consumers (e.g. `TerminalPanel` resolving a new PTY's cwd) must `await` or subscribe-until-`hydrated`.

## Adding a new store

1. Create `src/stores/<name>.store.ts`.
2. Use `create<State>()((set, get) => ({ … }))` from `zustand`.
3. Type both state shape and actions; keep actions pure where possible (no React imports inside the store file).
4. If the store needs persistence: add a field to `explorer.json` schema and wire it from the persistence layer (don't reach into `localStorage` from inside the store — keep persistence orchestration out of state files).
5. If the store needs to mirror main-process state: subscribe to the relevant `sessions_changed`-style IPC in a small `<SyncComponent />` at app root (model on `TerminalSessionsSync.tsx`).

## See also

- `electron/main/services/terminal-sessions.service.ts` — terminal-store truth source
- `src/panels/Editor/auto-save.ts` — pure-function layer the editor store leans on (ADR-015)
- ADR `doc/adr/ADR-007-zustand-pattern.md` — the vanilla-zustand goal (not yet implemented)
- ContinuoWiki tutorial 07 — store design rationale
