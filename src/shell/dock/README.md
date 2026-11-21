# `src/shell/dock/` — Dockview integration + per-terminal reconciler

The dock layer wraps [`dockview-react`](https://dockview.dev) and keeps it in sync with the terminal-sessions store. One terminal session = one dockview panel = one xterm instance. The reconciler is the one place that translates store state changes into dockview API calls.

## Key files

| File | Role |
|---|---|
| `DockShell.tsx` | Mounts `<DockviewReact>`, wires `panelComponents` (the React components dockview will instantiate for each `addPanel({ component })`), and exposes its `DockviewApi` through `dock-api-ref.ts`. |
| `DockReconciler.ts` | `reconcileTerminalPanels(api, { previousSessions, nextSessions })` — the 3-phase diff. Plus the React-side `useDockReconciler(api, hydrateBefore?, onHydrated?)` hook that subscribes to the terminal store (mounted by `DockShell.tsx`). |
| `wrap-panel-close.ts` | Patches every panel's `api.close` to mark it for the EXIT animation via `closing.store`, then, after `EXIT_DURATION_MS`: tell main to remove the panel's PTYs (skipped when the reconciler initiated the close, i.e. `markPanelCloseSuppressed` was set first), mark the close as suppressed (terminal panels), and call the original `close`. Re-opening the panel during the animation cancels the timer, so nothing is removed; if a reconciler-closed session becomes visible again during the animation, the reconciler cancels that close (`cancelReconcilerPanelClose`). Idempotent per panel. |
| `terminal-panel-id.ts` | Stable mapping `panelIdFor(sessionId)` ↔ `sessionIdFromPanel(panel)` and an `isTerminalPanelId` predicate. |
| `layout.default.ts` | The initial dockview layout used on first launch (when no `explorer.json` per-window layout exists). |
| `dock-api-ref.ts` | Mutable ref holding the live `DockviewApi`, so non-React code (event handlers, IPC plumbing) can reach it. |
| `EmptyState.tsx` | Centerpiece shown when no panels are open. |
| `HeaderActions.tsx` | Tab-strip right-side actions: popout (hidden inside popout windows) and the "more" menu for adding panels. |
| `TerminalSessionsSync.tsx` | Syncs main's sessions into `terminal.store` (initial `listSessions` + live `onSessionsChanged`, filtered by owner window and workspace root). |

## Reconciler — 3 phases

`reconcileTerminalPanels` does **only three** things, in order:

1. **Add panels** for sessions in `next` but not `prev`. Position: right of the last existing terminal panel (if there is none, no position is passed and dockview places it). Pending-focus (set via `setPendingFocus(sessionId)` by user paths like Cmd+T) gets consumed and the new panel auto-activates; otherwise focus snaps back to whichever panel was active *before* the add (so an agent spawning a panel doesn't steal focus from a user) — except a session the user created themselves (`originHint === 'user'`) that is appearing for the first time, is the newest user session in the snapshot, and is not part of layout hydration; that one is focused even without a pending-focus entry. A 5-second TTL prevents stale pending-focus from poisoning the next unrelated session.
2. **Close panels** for sessions in `prev` but not `next`. Goes through `markPanelCloseSuppressed(panelId) → panel.api.close()` so the close path knows this isn't a user-driven close (no PTY teardown — the session is already gone from the store).
3. **Retitle** panels whose session title (from main) changed.

That's it. No layout manipulation, no panel reordering — the store is the source of session existence, dockview owns the layout the user dragged into place.

## close-vs-move protocol

Dockview fires `onDidRemovePanel` for both genuine closes and "I'm moving this panel to another group" intermediate states. We can't tell which from the event payload alone, so:

- **Real close path** (× button / middle-click / programmatic): `wrap-panel-close.ts`'s patched `api.close` calls `markPanelCloseSuppressed(id)` *before* the actual `close()`. Then `handleTerminalPanelRemoved` (called from `onDidRemovePanel`) sees the suppressed flag → does nothing (the PTY was already removed in the patch).
- **Move path** (drag to another group): dockview synthesizes a remove+add. The suppressed flag is *not* set. `handleTerminalPanelRemoved` checks `await Promise.resolve()` + `api.getPanel(panelId)` — if the panel is still in the api after the microtask, it was a move, not a close. Bail out, do not remove the session.

This keeps PTYs alive through drag-reorder while still tearing them down on genuine close.

## Adding a new panel kind

Built-in panels (app code):

1. Build the panel as a React component that accepts `{ params }` from dockview (params travels via `addPanel({ params })`).
2. Register it in the panel registry under a stable string type (e.g. `"editor"`, `"explorer"`) — built-in panels and plugins (`registerPanel(spec)`) use the same registry; `panel-components.tsx` turns the registry snapshot into dockview's components map, so there is no hand-maintained map in `DockShell.tsx`.
3. Add panels by calling `api.addPanel({ id, component: 'your-key', title, params })`.

Plugin panels: register the type with `registerPanel(spec)` and open it with `app.dock.openPanel(id)`; the factory receives only `{ api }` (`PluginPanelProps`), no `params`.

For panels whose lifecycle is tied to backend state (like terminal sessions), use the reconciler pattern instead of imperative `addPanel`: keep state in a Zustand store, subscribe in a hook, diff prev/next, call `addPanel` / `panel.close` to converge.

## See also

- `src/stores/terminal.store.ts` — the truth source the reconciler watches
- `src/panels/Terminal/` — the actual xterm panel implementation
- `src/shell/motion/PanelMount.tsx` — EXIT animation triggered by `closing.store`
