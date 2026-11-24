# 终端与 dock tab 交互对齐 VSCode 集成终端

行为契约(参考 VSCode 集成终端的对应设置 / 命令):

1. **终端让出工作台命令键(commandsToSkipShell)**:终端聚焦时,`workbench.action.closeActiveEditor`(默认 mod+w)、
   `workbench.action.files.save`(默认 mod+s)、`terminal.clear`(默认 mod+k)的**生效绑定**不交给 xterm / shell
   (Win/Linux 上 Ctrl+S 不再发 XOFF 冻住终端,⌘W 不被吞)。按生效绑定判定:用户改绑 → 跟随新键,原键照常进 shell;
   解绑 → 不再让出。命令已注册 → 终端直接执行该命令并截住冒泡;尚未注册 → 只让出(不发给 shell),交给全局分发。
   默认键取已注册命令的 hotkey,未注册时用与注册方约定的常量兜底(不依赖注册时序)。
2. **⌘K 清屏**:命令 `terminal.clear`(默认 mod+k,三语标题)清空当前活动终端的屏幕与滚动缓冲(VSCode
   `workbench.action.terminal.clear`),经 terminal-panel-handles 的 `clear` 句柄执行;活动面板不是终端 → no-op。
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
5. **终端链接需修饰键单击**(VSCode):mac ⌘+单击、其它 Ctrl+单击才打开;悬停链接时提示「⌘+单击打开链接」。
6. **dock 激活 tab 的关闭按钮常显**(与编辑器 tab 一致),非激活 tab 仍悬停 / 聚焦时显示。
7. **dock 拖拽落点高亮等 dockview 字面色变量桥接到 `--md-*` token**,两主题各自取值。
8. **dock 溢出下拉按钮不与被截断的 tab 文字视觉粘连**:按钮有不透明底与分隔线。
9. **终端右键菜单**:复制(有选区才可用)/ 粘贴 / 全选 / 清除(= terminal.clear);Shift+F10 / 菜单键同样打开。
