# ADR-007 · Zustand for state, vanilla pattern as future direction

**Status**: Accepted (extracted from ContinuoWiki tutorial 06 §3.7, tutorial 07 §3.1, tutorial 08 §3.4) · Vanilla migration **not yet implemented**.

## Context

Continuo needs a renderer-side global state library for editor tabs, explorer tree state, terminal session mirror, workspace root, and several smaller UI concerns. Earlier MindAutonAgent work used Jotai mixed with Zustand; the resulting state model was hard to reason about across panels.

A secondary concern: a future Nous integration may want to drive renderer state from the main process (or a sister CLI), which favors a state library that can run **outside** React without a hook.

## Decision

1. **One state library for the whole renderer: Zustand 5.x.** Don't mix in Jotai, Redux, MobX, or hand-rolled context stores.
2. **Target pattern: `zustand/vanilla` + `useSyncExternalStore`** so each store is a pure value subscription that React only consumes via the standard React 18+ external-store hook. This keeps the door open for a non-React subscriber (e.g. Nous bridge) to read or drive the same store.

## Current state (verified 2026-05-17)

The target vanilla pattern is **not yet implemented**. Every store under `src/stores/` uses `import { create } from 'zustand'` directly, which is React-coupled. Refer:

- `src/stores/editor.store.ts` — `create<EditorState>()(…)` (header comment explicitly mentions ADR-007 as the target)
- `src/stores/explorer.store.ts`, `terminal.store.ts`, `closing.store.ts`, `agent-auth.store.ts`, `layout-ui.store.ts`, `pinned.store.ts`, `workspace.store.ts` — same shape

The decision to migrate stands; the migration was deferred because no concrete cross-realm consumer exists yet. When the Nous bridge work begins, the migration becomes load-bearing and should be done before that subscriber is built (otherwise the bridge will reach across React).

## Consequences

- Today: stores are simple to write but a non-React subscriber would need to import React just to read state.
- When Nous bridge lands: existing stores must be rewritten with `createStore` from `zustand/vanilla` and consumers updated to `useSyncExternalStore`. This is mechanical but touches every store.

## See also

- Tutorial 06 §3.7 (Explorer's three vanilla stores design intent)
- Tutorial 07 §3.4 (editor store: same library, no Jotai)
- Tutorial 08 §3.4 (plugin SDK exposes `app.stores` — needs stable surface)
- `src/stores/README.md` (current inventory)
