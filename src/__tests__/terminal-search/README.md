# terminal-search

## Scope

BDD coverage for issue #38: integrated terminal search with xterm search addon wiring, search bar UI, keyboard interception, panel scoping, cleanup, and race guards.

## Scenarios

- S1 `Cmd/Ctrl+F` opens search for the active terminal without writing `f` / `^F` to the PTY.
- S2 Typing a query calls `findNext` with decorations and updates match count from `onDidChangeResults`.
- S3 Empty query clears decorations and resets result state.
- S4 Enter navigates to next match; Shift+Enter navigates to previous match.
- S5 Regex / case-sensitive / whole-word toggles re-run search with updated options.
- S6 Escape or close hides the search bar, clears decorations, clears query, resets result state, and refocuses the terminal.
- S7 Input blur clears only the active decoration, leaving match highlights intact.
- S8 `isSearchHotkey` recognizes exact platform `mod+f` only.
- S9 Late `onDidChangeResults` events after unmount are ignored.
- S10 Search command scopes to the active terminal panel and does not open hidden or non-terminal panels.

## Manual smoke test checklist

- [ ] Active terminal: press Cmd/Ctrl+F -> search bar opens and no `f` / `^F` appears in the shell.
- [ ] Type a term that exists in scrollback -> matches highlight and counter shows current / total.
- [ ] Press Enter repeatedly -> selection advances through matches and wraps.
- [ ] Press Shift+Enter -> selection moves to the previous match.
- [ ] Toggle regex / match case / whole word -> search reruns and counter updates.
- [ ] Clear the query -> highlights disappear and counter resets.
- [ ] Press Escape -> search bar closes, decorations clear, terminal focus returns.
- [ ] Click close -> search bar closes, decorations clear, terminal focus returns.
- [ ] Pop out a terminal panel -> Cmd/Ctrl+F still opens search in the popout without PTY leakage.
- [ ] With editor active, press Cmd/Ctrl+F -> terminal search does not open for a hidden or inactive terminal.
