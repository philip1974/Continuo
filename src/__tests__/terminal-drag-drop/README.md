# terminal-drag-drop

Behavior contract for issue #39: dropping OS files, images, or directories onto a terminal panel inserts their shell-quoted paths at the cursor without submitting the command.

## Scope

External BDD:

- `drag-drop.spec.tsx` covers user-visible terminal drop behavior, PTY writes, focus, warning notifications, and propagation blocking.

Internal TDD:

- `shell-quote.spec.ts` covers the pure quoting and control-character rejection rules used by the drop behavior.

## Scenarios

- S1 single-file drop on macOS/zsh inserts a POSIX-quoted path plus one trailing space.
- S2 multi-file drop joins quoted paths with single spaces plus one trailing space.
- S3 path with spaces (`/Users/a b/c.txt`) is single-quoted on POSIX.
- S4 path with a single quote (`/Users/o'reilly.md`) becomes `'/Users/o'\''reilly.md'` on POSIX.
- S5 directory drop on terminal inserts the directory path instead of switching workspace, and calls `stopPropagation`.
- S6 web drag with synthetic `File` and no OS path performs no PTY write and shows `panels.terminal.drag_drop.no_os_path`.
- S7 path with a control character (`evil\nrm`) is rejected and counted in `panels.terminal.drag_drop.partial_skip`.
- S8 PowerShell session on Win32 uses single quotes with `''` escaping; double quotes are never used.

## Notes

- The terminal drop handlers should use `{ capture: true }` or an equivalent capture-phase upgrade if a future xterm.js version adds its own internal drop handler that swallows events before the panel wrapper sees them.
- `shellFamily` on `TerminalSession` is a known stub unless main-side shell-family population is wired. The renderer fallback is platform-based: Win32 uses PowerShell, other platforms use POSIX.

## Manual smoke test checklist

- [ ] Drag a file from Finder onto active terminal pane -> quoted path in PTY + trailing space + cursor stays in terminal
- [ ] Drag a directory onto terminal pane -> directory path inserted, NOT workspace switch
- [ ] Drag 2 files -> both paths space-joined + trailing space
- [ ] Drag a path with space in name -> single-quoted on POSIX
- [ ] devtools console shows `[terminal-drag-drop] capture drop` (DEV only)
- [ ] dockview tab-drag still works (drag terminal tab between groups)
- [ ] Terminal popout drop: open terminal in dockview popout BrowserWindow -> drag a file -> path inserted correctly
- [ ] Off-terminal directory drop: drag a directory onto explorer sidebar / status bar -> workspace switches (App.tsx path still works)

## Multi-document discipline

Terminal drag/drop listeners are bound to the terminal wrapper's current `ownerDocument`, not always the main window `document`. When dockview moves a group into or out of a popout BrowserWindow, `panel.api.onDidLocationChange` is the transition signal and the hook must re-read `ref.current.ownerDocument` after the move settles. Rebinds must be idempotent, must unbind the previous document, and must tolerate `ref.current` becoming null before a queued rebind runs. Future document-level terminal drag/drop changes should preserve this pattern so main-window, popout, and popout-to-grid round trips do not leak listeners across documents.
