# SDK Editor Namespace

Topic 29 adds the plugin-facing `app.editor.openFile(path, { line? })`
namespace.

These BDD specs pin the narrow contract:

- `openFile(path)` opens/switches editor tabs through the existing editor file
  action and reports no line jump.
- `openFile(path, { line })` waits for a CodeMirror view ref, scrolls to a
  valid line, and reports structured degradation for Milkdown, out-of-range
  lines, and unmounted tabs.
- failures preserve the editor SDK taxonomy:
  `INVALID_PATH`, `PERMISSION_DENIED`, `FS_NOT_FOUND`, `FS_NOT_FILE`,
  `FS_DENIED`, `FS_IO`, and `EXCEPTION`.
- scoped plugin access reuses the existing `fs` permission and path scope.
- editor view refs are runtime-only and unregister by view identity.

