# `src/stores/` — Renderer-side Zustand stores

Global state for the renderer. Each store owns one concern; modules cross-import sparingly (cross-store side effects belong in `useEffect` glue at the consumer, not in store actions).

All stores currently use `import { create } from 'zustand'` (React-coupled). A future move to `zustand/vanilla` is planned for clean separation between state logic and React subscriptions; that migration is **not yet implemented**.

## Inventory (10 stores)

| Store | Concern | Persisted? | Truth source |
|---|---|---|---|
| `editor.store.ts` | Open editor tabs (id / filePath / content / dirty), active tab, mode (`edit` / `source` / `preview`) | Partly (open file paths + active file via `explorer.json`; contents are not saved) | local |
| `explorer.store.ts` | Expanded paths set; sort preference (`name` / `mtime` / `ctime` / `size` + reverse — persisted but not yet applied to the tree) | partly (expanded + sort via `explorer.json`) | local |
| `terminal.store.ts` | `TerminalSession[]` mirror (id, title, cwd, originHint `user`/`agent`, agentLabel) | No (PTYs die on restart) | **main** (`sessions_changed`, pushed per owner window) |
| `closing.store.ts` | Set of panel ids currently playing the EXIT animation | No | local — see `src/shell/dock/wrap-panel-close.ts` |
| `agent-auth.store.ts` | Agent MCP authorization state: granted once per launch; one prompt shown at a time (in-window agents and external clients each get one pending slot); `revoke()` resets the grant — killing agent terminals is done by main (`revokeAndKillAgentSessions`) | No (intentional — re-prompt each launch) | local; main calls renderer via reverse-IPC |
| `layout-ui.store.ts` | Sidebar open/closed + width (clamped `[200, 500]`px, default 280) | Yes (per window: `explorer.json` `windows[].layoutUi`) | local |
| `pinned.store.ts` | Ordered list of pinned file paths (Explorer "pinned" section) | Yes (`explorer.json.pinned`) | local |
| `debug.store.ts` | Debug panel view: sessions, breakpoints, stack frames, scopes / variables of the stopped session | No | **main** (debug service pushes view events) |
| `settings.store.ts` | UI locale (en / zh / ko), applied across all windows | Yes (by main's settings) | **main** (`i18n:changed` broadcast) |
| `workspace.store.ts` | Workspace root + recent roots LRU (max 5) + `rootRestored` / `hydrated` flags for the persistence layer | Yes | local; consumers must wait on `rootRestored` (root only) or `hydrated` (root + editor tabs) before reading `root` |

## Why some stores are mirrors and some are local

- **`terminal.store`** is a renderer-side mirror of state owned by the main process. The PTY pool lives in main; the store just shows what main says exists. Renderer never `replaceSnapshot` from inside a UI handler, and keeps no terminal UI state of its own (which terminal is active is dockview's active panel). All session create/remove/title-change goes through `coApi.terminal.*` IPC and arrives back as the next `sessions_changed` broadcast.
- **`agent-auth.store`** is local for the *decision*, but the *prompt* is triggered from main via reverse-IPC. Decision is intentionally not persisted: every Continuo launch starts with no granted agent.
- **`debug.store`** and **`settings.store`** are also mirrors: main pushes debug view events and `i18n:changed` broadcasts.
- Everything else is renderer-local.

## `rootRestored` / `hydrated` gates (workspace store)

```
workspace.rootRestored === false → persistence layer hasn't finished reading explorer.json
                                 → workspace.root may still be null even if a saved root exists
                                 → consumers that race may emit IPC calls with no cwd → main responds
                                   with TERMINAL_CWD_UNRESOLVED
workspace.hydrated === false     → additionally, restored editor tabs may still be loading
                                   (hydrateEditorTabs: up to 256 tabs, 32 concurrent reads)
```

`initExplorerPersistence` flips `rootRestored = true` right after the root is restored (before the editor-tab reads), and `hydrated = true` after the tab reads. Both flip whether the read succeeds, fails, or finds no file, and `hydrated ⇒ rootRestored`.

- Consumers that only need `root` (new user terminal cwd — `createUserTerminal`; window→root push to main — `MainApp` notifyRoot; first-pass terminal filter — `TerminalSessionsSync`, which checks the same predicate inline) wait on `waitForWorkspaceRootRestored()` (`rootRestored || hydrated`). Waiting on `hydrated` here would put the editor-tab disk reads on the cold-start critical path.
- Consumers that also depend on the restored editor tabs must wait for `hydrated` (none exist today).

## Adding a new store

1. Create `src/stores/<name>.store.ts`.
2. Use `create<State>()((set, get) => ({ … }))` from `zustand`.
3. Type both state shape and actions; keep actions pure where possible (no React imports inside the store file).
4. If the store needs persistence: add a field to `explorer.json` schema and wire it from the persistence layer (don't reach into `localStorage` from inside the store — keep persistence orchestration out of state files).
5. If the store needs to mirror main-process state: subscribe to the relevant `sessions_changed`-style IPC in a small `<SyncComponent />` at app root (model on `TerminalSessionsSync.tsx`).

## See also

- `electron/main/services/terminal-sessions.service.ts` — terminal-store truth source
- `src/panels/Editor/auto-save.ts` — pure auto-save rules used by the editor's `useAutoSave` hook
