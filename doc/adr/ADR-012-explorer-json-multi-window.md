# ADR-012 · Per-window layout persistence in `explorer.json`

**Status**: Accepted, implemented (extracted from ContinuoWiki tutorial 02 §"doc/02 vs MVP 实际偏移").

## Context

The original dockview persistence design (doc/02) had a single `layout.json` at `${userData}/layout.json` storing the one-and-only renderer layout. This was adequate while Continuo was a single-window app.

When multi-window support landed (multiple `BrowserWindow`s, each with its own dockview, plus popouts that promote to standalone windows), the single-file model collapsed: which window's layout is "the" layout? Last-write-wins clobbers other windows' state. Loading on startup can't tell which window each `BrowserWindow` should restore.

## Decision

1. **One persistence file shared across all of Continuo's per-window UI state**: `${userData}/explorer.json` (name kept for backwards compat with the Explorer milestone where the file was introduced).
2. **Per-window segmentation by sequence id**: layout for window N lives under `windows[N].layout`. Sister fields (`windows[N].workspaceRoot`, `windows[N].pinned`, `windows[N].layoutUi`) follow the same shape.
3. **Window sequence id (`windowSeq`)** is allocated by `window-seq.service.ts` in main, persisted, and stable across restarts so a restored window finds its previous layout.
4. **Top-level `version: 3`** field for forward migration. v1 was the original single-layout file; v2 introduced per-window segmentation; v3 (current) split global state (`workspace.recentRoots` / `pinned`) into the top level while keeping per-window state (`workspace.root`, `explorer`, `layoutUi`, `editor`, `layout`, `lastClosedAt`) under `windows[windowSeq]`.

## Persistence rules

- Write path: `${userData}/explorer.json`
- Debounce: `onDidLayoutChange` 300 ms (`DEBOUNCE_MS` in `src/lib/persist/explorer-persist.ts`)
- Atomic write: `electron/main/lib/atomic-write.ts › atomicWriteJson` — a simpler temp + rename primitive than the 5-step backup flow in ADR-009. The snapshot is fully reconstructable from in-memory state at next save and the consequence of a partial write is "lose ≤ 300 ms of layout state, fall back to defaults on parse failure," so the extra `fsync` + `.backup` ceremony of ADR-009 is not justified here. ADR-009's stronger guarantees are reserved for user-edited files in `fs.writeFile` / `fs.writeBinary`.
- Parse failure (per window or whole file): fall back to `defaultLayout` for that window — **never throw to the user**. A corrupted layout file must not block app startup.

## Renderer flow

`DockShell.tsx`:
1. On mount: read `coApi.layout.read()`. Main resolves the calling window's seq, returns `windows[seq].layout` if present.
2. `event.api.fromJSON(layout)` (or `defaultLayout` on absence / parse fail).
3. Sanitize: drop any persisted `terminal` panels (they refer to dead PTYs). Drop orphan `explorer` panels (Explorer is now a sidebar, no longer a dockview panel).
4. Subscribe `onDidLayoutChange` (debounced 300 ms) → `coApi.layout.write(api.toJSON())` → main writes to `windows[seq].layout`.
5. App-quit `flush-ack` protocol: main asks renderer to flush, renderer flushes synchronously, acks, then main closes.

## Consequences

- Each window persists and restores independently. Closing window B has no effect on A's saved layout.
- A new window starts with `defaultLayout` (no inherited state) — by design.
- Schema migration story (version bumps): not yet exercised — to be handled when first incompatible change lands.
- The file name `explorer.json` is a historical artifact (originated in the Explorer milestone). Renaming would break upgrades, so it stays.

## See also

- ContinuoWiki tutorial 02 §"doc/02 vs MVP 实际偏移" (rationale and shape)
- `electron/main/persistence.ts`
- `src/shell/dock/DockShell.tsx` (sanitize + flush-ack)
- `electron/main/services/window-seq.service.ts`
- ADR-009 (atomic-write decision tree: snapshot files use a simpler temp+rename; user-edited files get the full 5-step backup ceremony)
- ADR-010 (`layout.*` channels return `IpcResult`)
