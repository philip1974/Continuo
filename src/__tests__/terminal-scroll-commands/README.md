# 终端滚动命令与未绑定 ⌘ 组合不进 shell

参考 VSCode `terminalActions.ts` 的 ScrollToTop / ScrollToBottom / ScrollUpPage / ScrollDownPage / ScrollUpLine / ScrollDownLine 与
`terminalInstance` 的按键让出判定。

修复前:`seq 1 300` 后按 ⌘Home 视口不滚到顶,反而跳回底部、提示符后出现 `;9H`(⌘End `;9F`、⌘PgDn `~`);vim / less 里这些序列
直接发给程序。原因是 xterm 把带 ⌘ 的 Home / End / PageUp / PageDown / Delete / F 键编码成 `ESC[1;9H` 等发给 PTY。

1. **六个滚动命令**(id、英文标题同 VSCode,三语标题,分类「终端」,命令面板可见、快捷键页可改键):
   - `workbench.action.terminal.scrollToTop` 滚动到顶部 —— mac ⌘Home,Windows / Linux Ctrl+Home;
   - `workbench.action.terminal.scrollToBottom` 滚动到底部 —— mac ⌘End,Windows / Linux Ctrl+End;
   - `workbench.action.terminal.scrollUpPage` 向上滚动(页)—— mac PageUp(附加默认键 ⌘PageUp),Windows / Linux ⇧PageUp;
   - `workbench.action.terminal.scrollDownPage` 向下滚动(页)—— mac PageDown(附加默认键 ⌘PageDown),Windows / Linux ⇧PageDown;
   - `workbench.action.terminal.scrollUp` 向上滚动(行)—— mac ⌥⌘PageUp,Windows / Linux Ctrl+Alt+PageUp;
   - `workbench.action.terminal.scrollDown` 向下滚动(行)—— mac ⌥⌘PageDown,Windows / Linux Ctrl+Alt+PageDown。

   执行时作用于触发窗口的活动终端:`scrollToTop()` / `scrollToBottom()` / `scrollPages(±1)` / `scrollLines(±1)`;活动面板不是
   终端 → 什么都不做。
   与 VSCode 的差异:mac 的 ⌘PageUp / ⌘PageDown 也翻页(mac 终端惯例;VSCode 没绑这两个键,按下会把 `ESC[5~` / `ESC[6~` 发给 shell);
   Continuo 的平台只分 mac / 其它,Linux 用 Windows 的默认键(VSCode Linux 是 ⇧Home / ⇧End / Ctrl+⇧↑ / Ctrl+⇧↓)。
2. **按键条件 `terminalNormalBufferFocus`**(VSCode `focusInAny_and_normalBuffer`):键只在焦点在终端、且终端在主缓冲时生效;
   在命令 `commandsToSkipShell` 默认列表里 → 胜出即让出,按键不交给 shell。全屏程序切到备用屏(vim / less)时不生效:
   PageUp / Ctrl+Home 等照常交给程序。焦点不在终端时这些键不触发滚动命令。改键 / 解绑跟随生效绑定。
3. **mac 未绑定的 ⌘ + 非字符键一律不交给 xterm**(Home / End / PageUp / PageDown / Delete / Insert / F1…F24 / Enter / Tab / Escape /
   方向键等,包括备用屏里的 ⌘Home):不往 shell / 程序写任何字节,也不截冒泡(全局快捷键照常)。已有的 ⌘← / ⌘→ / ⌘⌫ 行内编辑映射、
   ⌘C / ⌘V / ⌘A / ⌘K 等不受影响(⌘ + 字符键 xterm 本就不发字节)。与 VSCode 的差异:VSCode 只截住解析到命令的 ⌘ 键,未绑定的
   照常交给 xterm(会发出上述乱码);Continuo 按 mac 终端(Terminal.app / iTerm2)惯例丢弃。其它平台不变。

规范:`scroll-commands.spec.ts`(命令定义 / 注册 / 让出判定 / 兜底丢弃)、`terminal-wiring.spec.tsx`(useTerminal 接线);
e2e:`tests/e2e/terminal-scroll-commands.spec.ts`(真实 shell 与 vim)。
