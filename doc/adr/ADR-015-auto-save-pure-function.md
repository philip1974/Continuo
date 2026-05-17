# ADR-015 · Auto-save: differentiated by file kind, isolated as a pure function

**Status**: Accepted, implemented (extracted from ContinuoWiki tutorial 07 §3.7).

## Context

The Editor panel hosts both Markdown notes (Milkdown/Crepe) and code files (CodeMirror). These two surfaces have opposite expectations:

- **Markdown** is note-taking content. Users expect Notion/Obsidian-style "I closed the tab and my words are still there." A lost keystroke is a bug.
- **Code** is program source. Users expect VSCode-style explicit save. Auto-saving half-edited code can trigger watch-rebuilds, lint cascades, or — worse — push a broken file to a tool that's tailing it.

A single auto-save policy is wrong for at least one of these cases. The split needs to be the policy, not the engine choice.

## Decision

1. **Different defaults by file kind**:
   - Markdown (`.md` / `.markdown` — recognized by extension, mode-agnostic): **2-second debounced auto-save** after the last keystroke.
   - All other files (code, JSON, plain text): **no auto-save; require Cmd/Ctrl+S**.
2. **Implementation split** — two-file layering:
   - `src/panels/Editor/auto-save.ts` exports `makeAutoSaveScheduler(saveFile, delayMs) → { schedule, cancel }`. This is a **stateful scheduler factory** (it closes over a `setTimeout` timer), but it has zero React / IPC / store dependencies and is trivially unit-testable with fake timers.
   - `src/panels/Editor/useAutoSave.ts` is the React glue. It (a) subscribes to `editor.store` for the active tab, (b) builds one scheduler per `(saveFile, delayMs)` identity via `useMemo`, (c) in a `useEffect` checks `enabled && filePath && dirty` then calls `scheduler.schedule()`, (d) cancels on unmount.
   - The same file also exports the pure predicate `isAutoSaveEnabled(filePath: string | null) → boolean` — the single source of truth for "is this a markdown file we should auto-save?" Callers must not sprinkle `endsWith('.md')` checks throughout.
3. **User-configurable via settings**: `autoSave.markdown.enabled` (default `true`) and `autoSave.delayMs` (default `2000`) are exposed in Settings → Editor. `EditorPanel.tsx` composes the final `enabled` as `isAutoSaveEnabled(filePath) && mdAutoSaveEnabled`.
4. **Cmd/Ctrl+S works in every mode** — explicit save is a no-op if the file is clean and an immediate flush if it isn't. Intercepted at the `EditorPanel` root `onKeyDown`; Crepe does not swallow ⌘S.
5. **Mode-agnostic on purpose** — editing markdown in source mode (raw `.md` shown in CodeMirror) still auto-saves; it's the same file and the user expectation is the same. The "mode" only affects which editor surface renders the buffer.

## Implementation notes

- Unit tests exercise the scheduler with fake timers: see the auto-save tests under `src/__tests__/editor-hooks/`. No Electron, IPC, or React harness required because the scheduler factory has no dependencies on any of them.
- `fs.writeFile` (which the `saveFile` closure ultimately invokes through `coApi.fs.writeFile`) goes through ADR-009 atomic write, so an auto-save interrupted by a crash never half-writes the file.
- Tabs are dirty iff `tab.content !== tab.originalContent` (textual compare); undo back to the original state correctly returns the tab to clean and the scheduler's next tick becomes a no-op.

## Consequences

- Markdown users get "I never have to press save" UX.
- Code users get "save is something I do deliberately" UX.
- New file kinds default to the explicit-save side; opt them into auto-save by extending `isAutoSaveEnabled`.
- The pure-layer split is a template for the rest of the codebase: behavior that the team will want to unit-test should not live inside a `useEffect`.

## See also

- ContinuoWiki tutorial 07 §3.7 + §"目录结构和文件拆分演化"
- `src/panels/Editor/auto-save.ts` (pure layer)
- `src/panels/Editor/useAutoSave.ts` (React hook glue)
- ADR-009 (atomic write the save path lands on)
