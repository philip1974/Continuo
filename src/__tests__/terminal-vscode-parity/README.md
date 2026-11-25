# 终端与 dock tab 交互对齐 VSCode 集成终端

行为契约(参考 VSCode 集成终端的对应设置 / 命令):

1. **终端让出工作台命令键(commandsToSkipShell)**:对齐 VSCode terminalInstance 的让出判定
   `event.metaKey || shouldCommandSkipShell(commandId)`:
   - `terminal.clear` 在 VSCode 默认 commandsToSkipShell 里 → 其**生效绑定**不交给 xterm / shell;
   - `workbench.action.closeActiveEditor`(默认 mod+w)、`workbench.action.files.save`(默认 mod+s)不在列表里 →
     只有按键带 Meta 时让出:mac 上 ⌘W / ⌘S 让出(不被 xterm 吞);**Windows / Linux 上 Ctrl+W(删前一词)/
     Ctrl+S(XOFF)照常进 shell**,不关终端、不触发保存(与 VSCode 一致,有意不偏离)。
   按生效绑定判定:用户改绑 → 跟随新键,原键照常进 shell;解绑 → 不再让出。命令已注册 → 终端直接执行该命令并截住
   冒泡;尚未注册 → 只让出(不发给 shell),交给全局分发。默认键取已注册命令的 hotkey,未注册时用与注册方约定的
   默认键兜底(不依赖注册时序)。**与全局分发一张表裁决**(`winningCommandFor`):该键的胜出命令是别的命令(如用户把
   新建终端绑到 ⌘K)→ 不让出、不清屏 / 不保存,按键交给全局分发执行胜出命令(见 `keybinding-user-priority`)。
   事件所在文档有打开的 Modal → 不让出(见 `hotkey-modal-suppression`)。
2. **⌘K 清屏**:命令 `terminal.clear`(三语标题)清空当前活动终端的屏幕与滚动缓冲(VSCode
   `workbench.action.terminal.clear`),经 terminal-panel-handles 的 `clear` 句柄执行;活动面板不是终端 → no-op。
   默认键同 VSCode(`primary: 0, mac: Cmd+K`):**仅 mac ⌘K**;Windows / Linux 不设默认键,Ctrl+K 照常进 shell
   (readline 删到行尾),全局分发也不再拦 Ctrl+K;用户自行绑定后按绑定让出。
3. **进程退出**(VSCode `TerminalInstance._onProcessExit`):
   - 用户终端退出码 0 → 自动关闭面板(静默,VSCode 默认行为);
   - 非 0(或 agent 会话任意退出码)→ 终端内写一行「终端进程已终止,退出代码: N」与「按任意键关闭终端」
     (VSCode 任务终端 waitOnExit 文案),此后键入不再发 IPC(不再每 3 秒报「找不到终端」),任意键关闭面板;
   - tab 标题追加「(已退出)」后缀;
   - agent(MCP)会话不自动关闭:关闭面板会删除 main 侧会话记录,agent 再 list_sessions 看不到 exit_code。
4. **关闭仍有子进程的终端须确认**(VSCode `terminal.integrated.confirmOnKill` 默认 `editor`):确认放在面板关闭的公共路径
   (`wrapPanelClose` 的关闭守卫),× / 中键 / Delete / ⌘W / 任何 `api.close()` 都经过;main 以 node-pty 前台进程名
   与 shell 名比较判断。有子进程 → 破坏性确认框「终止正在运行的进程?」(默认焦点在取消);无子进程 / 已退出 /
   reconciler 收敛视图的关闭 → 直接关。
   - 终端在 popout 子窗:确认框画在**该子窗**(portal 进面板所在文档);确认期间子窗被关 → 改画在主窗(不卡住)。
     取消后焦点还给该终端。
   - 确认框等待期间来了 reconciler 的关闭(agent 杀会话 / 切工作区隐藏 / shell 以 0 退出):不被「询问中」去重吞掉 ——
     待定确认按「取消」结算并清掉确认框,面板照常收敛视图(不留僵尸面板、不残留 suppressed 标记);尚在查询子进程的,
     查询回来后不再弹框。
5. **终端链接需修饰键单击**(VSCode):mac ⌘+单击、其它 Ctrl+单击才打开;悬停链接时提示「⌘+单击打开链接」。
6. **dock 激活 tab 的关闭按钮常显**(与编辑器 tab 一致),非激活 tab 仍悬停时显示(关闭按钮不可聚焦,键盘走 Delete)。
7. **dock 拖拽落点高亮等 dockview 字面色变量桥接到 `--md-*` token**,两主题各自取值。
8. **dock 溢出下拉按钮不与被截断的 tab 文字视觉粘连**:按钮有不透明底与分隔线。
9. **终端右键菜单**:复制(有选区才可用)/ 粘贴 / 全选 / 清除(= terminal.clear);Shift+F10 / 菜单键同样打开。
10. **mac 行内编辑键**(VSCode `registerSendSequenceKeybinding` 的 mac 默认绑定):⌘← 发 `^A`(行首)、⌘→ 发 `^E`(行尾)、
    ⌘⌫ 发 `^U`(删到行首);⌥← / ⌥→ 发 `ESC b` / `ESC f`(按单词移动 —— xterm 6 已去掉把 ⌥← 改写成 `ESC b` 的 mac 特例,
    默认发 `ESC[1;3D`,zsh / bash 默认键表不认,会打出 `;3D`)。只在 mac、恰好该修饰键时生效,经 `term.input` 走 onData
    同一写入路径(进程退出后不发);排在「让出给工作台命令」之后:用户把这些键绑给终端让出的命令时仍让出。xterm 对带 ⌘
    的方向键什么都不发、⌘⌫ 只发 DEL(`mac-line-editing-keys.spec.tsx`)。
