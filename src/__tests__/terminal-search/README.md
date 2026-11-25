# terminal-search

## Scope

BDD coverage for issue #38: integrated terminal search with xterm search addon wiring, search bar UI, keyboard interception, panel scoping, cleanup, and race guards.

## Scenarios

- S1 `Cmd/Ctrl+F` opens search for the active terminal without writing `f` / `^F` to the PTY.
- S1b 搜索条已打开时再次 open(`Cmd/Ctrl+F` / 命令面板):`focusRequest` 递增,输入框重新获得焦点并全选已有搜索词(VSCode 行为),不让后续输入与回车落进 shell(`search-bar.spec.tsx` / `search-debounce.spec.ts` S14)。
- S2 Typing a query calls `findNext` with decorations and updates match count from `onDidChangeResults`.
- S2b `SearchAddon` 以显式 `highlightLimit = TERMINAL_SEARCH_HIGHLIGHT_LIMIT`(1000)构造,结果收集到上限即停:计数达上限时总数显示「1000+」;当前匹配不在已收集结果内(`resultIndex = -1`)时只显示总数(`match_total`),不显示「0 / 1000」。
- S2c 输入搜索词 / 切换选项时从底部(最近输出)向上增量搜索(VSCode `TerminalFindWidget._onInputChanged`:`findPrevious` + `incremental: true`),先落最近的匹配,视口不被拉到回滚区顶部;当前匹配仍符合新词时原地保留。兄弟包 `applyTerminalSearchEffect` 用 `findNext`(从顶部往下),在 Continuo 包装层(`terminal-search-state.ts`)覆盖这两种动作,不改兄弟仓库(`incremental-from-bottom.spec.tsx`)。
- S3 Empty query clears decorations and resets result state.
- S4 Enter navigates to next match; Shift+Enter navigates to previous match.
- S4c 终端搜索条 Enter 向上(更早的输出,`prev`)、Shift+Enter 向下(`next`),对齐 VSCode 终端查找(`findPrevious` 绑 Enter、`findNext` 绑 Shift+Enter;输入后已落在最近的匹配,Enter 继续往更早处找,不绕回缓冲顶部)。由 `enterFindsPrevious` 开启,终端面板传入;Markdown 查找复用本搜索条时缺省仍 Enter 向下(`incremental-from-bottom.spec.tsx`)。
- S4b IME 组合中(`isComposing` / `keyCode 229`)的 Enter / Escape 不跳转、不关闭(属于输入法)。
- S5 Regex / case-sensitive / whole-word toggles re-run search with updated options.
- S6 Escape or close hides the search bar, clears decorations, clears query, resets result state, and refocuses the terminal.
- S6b Escape 挂在搜索条根节点:焦点在选项(`.*` / `Aa` / `W`)或跳转(上一个 / 下一个)按钮上时同样关闭并把焦点还给终端;输入框内的 Escape 只关闭一次。
- S6c 上一个 / 下一个 / 关闭按钮是 design `IconButton` + `@/lib/ui-icons` 的 `ChevronUpIcon` / `ChevronDownIcon` / `CloseIcon`(16×16 stroke SVG,`aria-hidden`),不再用 ASCII「^ v x」(字形大小 / 基线与 `.*` / `Aa` / `W` 不齐);可访问名由 `aria-label` 提供(`search-bar.spec.tsx`)。
- S7 Input blur clears only the active decoration, leaving match highlights intact.
- S8 `isSearchHotkey` recognizes exact platform `mod+f` only. The terminal itself intercepts via
  `isTerminalSearchHotkey` (`src/panels/Terminal/terminal-hotkeys.ts`), which follows the user's effective binding of
  `terminal.search.toggle` (rebound → new key; unbound → Ctrl/Cmd+F reaches the shell).
- S9 Late `onDidChangeResults` events after unmount are ignored.
- S10 Search command scopes to the active terminal panel and does not open hidden or non-terminal panels.
- S11 正则模式下非法正则(`[` / `(` / `\`)不抛错:调用侧预校验,不交给 SearchAddon,清高亮并把结果置为「无匹配」,搜索条照常可用;改回合法正则后照常搜索;之前合法搜索留下的 xterm 选中(selection)一并清除(`invalid-regex.spec.ts`)。搜索条的计数区不显示「无匹配」而是「正则表达式无效」(`editor.find.invalid_regex`,错误色),输入框 `aria-invalid`,`new RegExp` 抛出的错误信息作输入框与计数区的 `title`(悬停可见,也是输入框的可访问描述;VSCode 查找框弹出正则错误)(`search-bar.spec.tsx` S16)。
- S12 输入搜索词的 `findNext`(同步扫描整段 scrollback)防抖 `TERMINAL_SEARCH_DEBOUNCE_MS`(100ms):输入框状态立即更新,停顿后只按最终词搜一次;Enter/上下跳转/选项切换/失焦先 flush 再执行;关闭/清空/卸载/切 session 取消挂起搜索(`search-debounce.spec.ts`)。
- S13 搜索高亮装饰色运行时取自主题 token(`--md-primary-container` / `--md-primary` / `--md-on-primary-container`,light / dark 各有值,经共享 `readThemeTokens` 读取);token 读不到或非 `#RRGGBB` 时用暗色兜底色。主题(resolved)切换后清掉旧高亮,下一次搜索按新主题取色(`theme-decorations.spec.ts`)。
- S15 窄分栏(对齐 VSCode 查找框 reduced / collapsed-find-widget):搜索条宽度封顶在终端面板内(`max-w-[calc(100%-1rem)]`),输入框随之收窄(保底 `min-w-16`)始终可见,不再整体右对齐溢出后被 dockview `.dv-view{overflow:clip}` 把输入框裁掉;面板 < 24rem 时匹配计数转 `sr-only`(live region 仍播报),< 20rem 时隐藏选项组与上 / 下一个,只剩输入框 + 关闭。容器查询以终端面板根节点 `@container/terminal` 为准(`search-bar.spec.tsx` S15;真机 e2e `tests/e2e/terminal-search-narrow.spec.ts`)。
- S16 搜索条被 Markdown 编辑 / 预览查找复用时的可选项(终端不传,行为不变):`label`(输入框标签与占位文案,编辑器传「查找」)、`history`(查找框 ↑ / ↓ 翻历史,回车与卸载时记入);`focusRequest = 0` 表示恢复显示而非用户打开,挂载时不抢焦点(`search-bar.spec.tsx` S16)。

## Manual smoke test checklist

- [ ] Active terminal: press Cmd/Ctrl+F -> search bar opens and no `f` / `^F` appears in the shell.
- [ ] Type a term that exists in scrollback -> matches highlight and counter shows current / total.
- [ ] `seq 1 200000`, type `1999` -> the most recent match (near the bottom) is selected; the viewport is not dragged to the top of scrollback.
- [ ] Press Enter repeatedly -> selection moves up through older matches and wraps.
- [ ] Press Shift+Enter -> selection moves down to the newer match.
- [ ] Toggle regex / match case / whole word -> search reruns and counter updates.
- [ ] Clear the query -> highlights disappear and counter resets.
- [ ] Press Escape -> search bar closes, decorations clear, terminal focus returns.
- [ ] Click `Aa` then press Escape -> search bar closes, terminal focus returns.
- [ ] Type `foo`, click the terminal body, press Cmd/Ctrl+F again -> input refocuses with `foo` selected.
- [ ] Search a term with >1000 matches -> counter shows `n / 1000+` (or `1000+ matches` when the active match is beyond the first 1000).
- [ ] Click close -> search bar closes, decorations clear, terminal focus returns.
- [ ] Pop out a terminal panel -> Cmd/Ctrl+F still opens search in the popout without PTY leakage.
- [ ] With editor active, press Cmd/Ctrl+F -> terminal search does not open for a hidden or inactive terminal.
