# terminal-search

## Scope

BDD coverage for issue #38: integrated terminal search with xterm search addon wiring, search bar UI, keyboard interception, panel scoping, cleanup, and race guards.

## Scenarios

- S1 `Cmd/Ctrl+F` opens search for the active terminal without writing `f` / `^F` to the PTY.
- S1b 搜索条已打开时再次 open(`Cmd/Ctrl+F` / 命令面板):`focusRequest` 递增,输入框重新获得焦点并全选已有搜索词(VSCode 行为),不让后续输入与回车落进 shell(`search-bar.spec.tsx` / `search-debounce.spec.ts` S14)。
- S2 Typing a query calls `findNext` with decorations and updates match count from `onDidChangeResults`.
- S2b `SearchAddon` 以显式 `highlightLimit = TERMINAL_SEARCH_HIGHLIGHT_LIMIT`(1000)构造,结果收集到上限即停:计数达上限时总数显示「1000+」;当前匹配不在已收集结果内(`resultIndex = -1`)时只显示总数(`match_total`),不显示「0 / 1000」。
- S3 Empty query clears decorations and resets result state.
- S4 Enter navigates to next match; Shift+Enter navigates to previous match.
- S4b IME 组合中(`isComposing` / `keyCode 229`)的 Enter / Escape 不跳转、不关闭(属于输入法)。
- S5 Regex / case-sensitive / whole-word toggles re-run search with updated options.
- S6 Escape or close hides the search bar, clears decorations, clears query, resets result state, and refocuses the terminal.
- S6b Escape 挂在搜索条根节点:焦点在选项(`.*` / `Aa` / `W`)或跳转(`^` / `v`)按钮上时同样关闭并把焦点还给终端;输入框内的 Escape 只关闭一次。
- S7 Input blur clears only the active decoration, leaving match highlights intact.
- S8 `isSearchHotkey` recognizes exact platform `mod+f` only. The terminal itself intercepts via
  `isTerminalSearchHotkey` (`src/panels/Terminal/terminal-hotkeys.ts`), which follows the user's effective binding of
  `terminal.search.toggle` (rebound → new key; unbound → Ctrl/Cmd+F reaches the shell).
- S9 Late `onDidChangeResults` events after unmount are ignored.
- S10 Search command scopes to the active terminal panel and does not open hidden or non-terminal panels.
- S11 正则模式下非法正则(`[` / `(` / `\`)不抛错:调用侧预校验,不交给 SearchAddon,清高亮并把结果置为「无匹配」,搜索条照常可用;改回合法正则后照常搜索;之前合法搜索留下的 xterm 选中(selection)一并清除(`invalid-regex.spec.ts`)。
- S12 输入搜索词的 `findNext`(同步扫描整段 scrollback)防抖 `TERMINAL_SEARCH_DEBOUNCE_MS`(100ms):输入框状态立即更新,停顿后只按最终词搜一次;Enter/上下跳转/选项切换/失焦先 flush 再执行;关闭/清空/卸载/切 session 取消挂起搜索(`search-debounce.spec.ts`)。
- S13 搜索高亮装饰色运行时取自主题 token(`--md-primary-container` / `--md-primary` / `--md-on-primary-container`,light / dark 各有值,经共享 `readThemeTokens` 读取);token 读不到或非 `#RRGGBB` 时用暗色兜底色。主题(resolved)切换后清掉旧高亮,下一次搜索按新主题取色(`theme-decorations.spec.ts`)。

## Manual smoke test checklist

- [ ] Active terminal: press Cmd/Ctrl+F -> search bar opens and no `f` / `^F` appears in the shell.
- [ ] Type a term that exists in scrollback -> matches highlight and counter shows current / total.
- [ ] Press Enter repeatedly -> selection advances through matches and wraps.
- [ ] Press Shift+Enter -> selection moves to the previous match.
- [ ] Toggle regex / match case / whole word -> search reruns and counter updates.
- [ ] Clear the query -> highlights disappear and counter resets.
- [ ] Press Escape -> search bar closes, decorations clear, terminal focus returns.
- [ ] Click `Aa` then press Escape -> search bar closes, terminal focus returns.
- [ ] Type `foo`, click the terminal body, press Cmd/Ctrl+F again -> input refocuses with `foo` selected.
- [ ] Search a term with >1000 matches -> counter shows `n / 1000+` (or `1000+ matches` when the active match is beyond the first 1000).
- [ ] Click close -> search bar closes, decorations clear, terminal focus returns.
- [ ] Pop out a terminal panel -> Cmd/Ctrl+F still opens search in the popout without PTY leakage.
- [ ] With editor active, press Cmd/Ctrl+F -> terminal search does not open for a hidden or inactive terminal.
