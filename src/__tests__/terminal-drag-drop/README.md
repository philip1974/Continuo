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
