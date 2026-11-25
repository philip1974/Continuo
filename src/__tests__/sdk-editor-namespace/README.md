# SDK Editor Namespace

Topic 29 adds the plugin-facing `app.editor.openFile(path, { line? })`
namespace.

These BDD specs pin the narrow contract:

- `openFile(path)` opens/switches editor tabs through the existing editor file
  action and reports no line jump.
- `openFile(path, { line, column?, length? })` waits for a CodeMirror view ref,
  scrolls to a valid line and selects `length` UTF-16 code units from `column`
  (cursor only without `length`; clamped to the line end), and reports structured
  degradation for out-of-range lines and unmounted tabs.
- Markdown in edit / preview mode (Milkdown) hands the same target to that tab's
  Milkdown view (`markdown-reveal-registry`, see `search-open-markdown`) instead of
  reporting `milkdown-engine`: `applied` → `lineApplied: true`, `out-of-range` →
  `line-out-of-range`, view not ready in time → `tab-not-mounted`
  (`openFile-milkdown.spec.ts`).
- failures preserve the editor SDK taxonomy:
  `INVALID_PATH`, `PERMISSION_DENIED`, `FS_NOT_FOUND`, `FS_NOT_FILE`,
  `FS_DENIED`, `FS_IO`, and `EXCEPTION`.
- scoped plugin access reuses the existing `fs` permission and path scope.
- editor view refs are runtime-only and unregister by view identity.

- cold load / concurrency (`openFile-cold-load.spec.ts`): a line jump preloads the
  CodeEditor engine chunks (shared promise with the lazy panel/engine) and only
  starts the bounded 500ms mount wait once they are ready; the view is re-checked
  against `viewRefs` so a view destroyed while chunks load is never scrolled.
  Right before scrolling the store is re-read: the target must still be the active
  tab and still in CodeMirror mode (same effective-mode rule as the pre-check), so a
  tab switch / Markdown Source→Edit whose old view is not yet cleaned up returns
  `tab-not-mounted` / `milkdown-engine` instead of a false `lineApplied: true`.
