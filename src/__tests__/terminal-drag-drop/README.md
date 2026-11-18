# terminal-drag-drop

Behavior contract for issue #39: dropping OS files, images, or directories onto a terminal panel inserts their shell-quoted paths at the cursor without submitting the command.

## Scope

External BDD:

- `drag-drop.spec.tsx` covers user-visible terminal drop behavior, PTY writes, focus, warning notifications, and propagation blocking.

Internal TDD:

- `@/lib/terminal-drop-quote` wraps the sibling package with Continuo-side injection hardening; `@continuo-terminal/shell-quote (shell-quote)` covers the pure quoting and control-character rejection rules used by the drop behavior.

## Scenarios

- S1 single-file drop on macOS/zsh inserts a POSIX-quoted path plus one trailing space.
- S2 multi-file drop joins quoted paths with single spaces plus one trailing space.
- S3 path with spaces (`/Users/a b/c.txt`) is single-quoted on POSIX.
- S4 path with a single quote (`/Users/o'reilly.md`) becomes `'/Users/o'\''reilly.md'` on POSIX.
- S5 directory drop on terminal inserts the directory path instead of switching workspace, and calls `stopPropagation`.
- S6 web drag with synthetic `File` and no OS path performs no PTY write and shows `panels.terminal.drag_drop.no_os_path`.
- S7 path with a control character (`evil\nrm`) is rejected and counted in `panels.terminal.drag_drop.partial_skip`.
- S8 PowerShell session on Win32 uses single quotes with `''` escaping when the path has no cmd metacharacters (`& | < > ^`), `"` or paired `%name%` (see S11 for the double-quote form).
- S9 (security, `drop-quote-injection.spec.ts`) POSIX-family paths containing `\` keep `\` and `'` outside the quotes (`\\`, `\'`), so the inserted text parses back to the original single argument in bash, zsh (incl. `RC_QUOTES`) and fish — fish treats `\'`/`\\` inside single quotes as escapes, so the plain `'\''` splice let `a\'; touch pwned #` break out.
- S10 (security, `drop-quote-powershell.spec.ts`) PowerShell sessions double every single-quote-class character (`'` and U+2018–U+201B), because PowerShell treats `‘ ’ ‚ ‛` as single-quote delimiters too; `a’;calc;’.txt` must stay one literal argument.
- S11 (security, `drop-quote-windows-nested.spec.ts`) the shell family comes from the PTY's startup shell, so a user who runs `cmd` inside a PowerShell terminal (or `powershell` inside a cmd terminal) is not detected. Windows-family output must therefore execute nothing in **both** cmd and PowerShell, and parse back to the original path in the startup shell:
  - `"…"` is used when the path contains none of `"` `%` `!` `$` `` ` `` and U+201C–U+201E — inside cmd double quotes `& | < > ^ ( )` are literal (only `"` toggles, `%`/`!` expand); inside PowerShell double-quoted strings only `$`, `` ` `` and `"`/U+201C–U+201E are special (about_Quoting_Rules).
  - PowerShell sessions keep the S8/S10 single-quote form when the path has no `& | < > ^ "`: cmd sees plain text (no execution), so `$`, backticks and smart double quotes still work there. `!` is allowed in this form because cmd delayed expansion runs after command parsing (value change only, never execution). A single `%` is allowed too (`a%20b.pdf`, `100%.png` are common download names), but a paired `%name%` (non-empty name without `%`) is not: cmd expands it before parsing, and dynamic variables such as `%CD%` / `%__CD__%` / `%=C:%` yield the current directory name, which can come from an untrusted repository (directory `x&calc&y` + file `%CD%.txt`, dropped after nesting cmd in PowerShell → the expanded `&` executes `calc`).
  - Otherwise the path is skipped (`cmd_unrepresentable`, counted in `partial_skip`). E.g. PowerShell `x&calc&.txt` → `"…x&calc&.txt"`; cmd `a$(calc).txt` / `a“;calc;“.txt` → skipped. Spaces, parentheses, `&`, `'` and CJK names are never skipped in either family; PowerShell `a%20b.pdf` stays `'…a%20b.pdf'`, while PowerShell `%TEMP%.txt` / `a%20b%20c.pdf` (paired `%…%`) are skipped; cmd sessions still skip any `%`. PowerShell paths containing `%`/`$`/`` ` ``/`!`/smart double quotes together with `& | < > ^` are skipped.

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
