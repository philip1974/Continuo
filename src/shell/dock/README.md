# `src/shell/dock/` — Dockview integration + per-terminal reconciler

The dock layer wraps [`dockview-react`](https://dockview.dev) and keeps it in sync with the terminal-sessions store. One terminal session = one dockview panel = one xterm instance (decision logged at topic-07). The reconciler is the one place that translates store state changes into dockview API calls.

## Key files

| File | Role |
|---|---|
| `DockShell.tsx` | Mounts `<DockviewReact>`, wires `panelComponents` (the React components dockview will instantiate for each `addPanel({ component })`), and exposes its `DockviewApi` through `dock-api-ref.ts`. |
| `DockReconciler.ts` | `reconcileTerminalPanels(api, { previousSessions, nextSessions, customTitles })` — the 3-phase diff. Plus the React-side `useDockReconciler(api)` hook that subscribes to the terminal store. |
| `wrap-panel-close.ts` | Patches every panel's `api.close` to (a) mark it for the EXIT animation via `closing.store`, (b) cancel any in-flight `spawnLeaf` PTY spawns, (c) tell main to remove the PTY, (d) call the original `close` after `EXIT_DURATION_MS`. Idempotent per panel. |
| `terminal-panel-id.ts` | Stable mapping `panelIdFor(sessionId)` ↔ `sessionIdFromPanel(panel)` and an `isTerminalPanelId` predicate. |
| `layout.default.ts` | The initial dockview layout used on first launch (when no `explorer.json` per-window layout exists). |
| `dock-api-ref.ts` | Mutable ref holding the live `DockviewApi`, so non-React code (event handlers, IPC plumbing) can reach it. |
| `EmptyState.tsx` | Centerpiece shown when no panels are open. |
| `HeaderActions.tsx` | Tab-strip right-side actions (split / popout / kebab). |
| `TerminalSessionsSync.tsx` | The component that mounts `useDockReconciler` against the live api ref. |

## Reconciler — 3 phases

`reconcileTerminalPanels` does **only three** things, in order:

1. **Add panels** for sessions in `next` but not `prev`. Position: right of the last existing terminal panel (or first if none). Pending-focus (set via `setPendingFocus(sessionId)` by user paths like Cmd+T) gets consumed and the new panel auto-activates; otherwise focus snaps back to whichever panel was active *before* the add (so an agent spawning a panel doesn't steal focus from a user). A 5-second TTL prevents stale pending-focus from poisoning the next unrelated session.
2. **Close panels** for sessions in `prev` but not `next`. Goes through `markPanelCloseSuppressed(panelId) → panel.api.close()` so the close path knows this isn't a user-driven close (no PTY teardown — the session is already gone from the store).
3. **Rename** panels whose `customTitles` entry changed.

That's it. No layout manipulation, no panel reordering — the store is the source of session existence, dockview owns the layout the user dragged into place.

## close-vs-move protocol

Dockview fires `onDidRemovePanel` for both genuine closes and "I'm moving this panel to another group" intermediate states. We can't tell which from the event payload alone, so:

- **Real close path** (× button / middle-click / programmatic): `wrap-panel-close.ts`'s patched `api.close` calls `markPanelCloseSuppressed(id)` *before* the actual `close()`. Then `handleTerminalPanelRemoved` (called from `onDidRemovePanel`) sees the suppressed flag → does nothing (the PTY was already removed in the patch).
- **Move path** (drag to another group): dockview synthesizes a remove+add. The suppressed flag is *not* set. `handleTerminalPanelRemoved` checks `await Promise.resolve()` + `api.getPanel(panelId)` — if the panel is still in the api after the microtask, it was a move, not a close. Bail out, do not remove the session.

This keeps PTYs alive through drag-reorder while still tearing them down on genuine close.

## Adding a new panel kind

1. Build the panel as a React component that accepts `{ params }` from dockview (params travels via `addPanel({ params })`).
2. Register the component in `DockShell.tsx`'s `panelComponents` map under a stable string id (e.g. `"editor"`, `"explorer"`).
3. Add panels by calling `api.addPanel({ id, component: 'your-key', title, params })` — either directly from app code, or via a plugin's `registerPanel(spec)`.

For panels whose lifecycle is tied to backend state (like terminal sessions), use the reconciler pattern instead of imperative `addPanel`: keep state in a Zustand store, subscribe in a hook, diff prev/next, call `addPanel` / `panel.close` to converge.

## See also

- `src/stores/terminal.store.ts` — the truth source the reconciler watches
- `src/panels/Terminal/` — the actual xterm panel implementation
- `src/shell/motion/PanelMount.tsx` — EXIT animation triggered by `closing.store`
- ADR `doc/adr/ADR-012-explorer-json-multi-window.md` — multi-window layout persistence
- ContinuoWiki tutorial 02 (dockview skeleton) + tutorial 09 (terminal-per-panel) — design history
