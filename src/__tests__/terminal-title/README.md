# terminal-title — 终端 tab 标题:进程名 / 重命名

对齐 VSCode 集成终端的默认标题:`terminal.integrated.tabs.title` = `${process}`(前台进程名,shell 空闲时即 shell 名);
终端 tab 右键「重命名…」= `workbench.action.terminal.rename`(TitleEventSource.Api,固定)。VSCode 默认模板不含
`${sequence}`(程序经 OSC 0 / 2 设的标题),这里同样不显示。

## 行为契约

1. **基础名优先级**(`terminalPanelTitle` / `terminalBaseTitle`,DockReconciler 与 TerminalPanelView 共用):
   用户重命名 > 前台进程名(含 shell 本身:空闲时 `zsh` / `bash`,运行程序时 `vim` / `node`)> 默认名「终端 N」(按当前语言)/
   显式 session 标题(进程名未知时的兜底)。agent 会话仍加 ` (agent)` 后缀,已退出仍加「(已退出)」;已退出时不再显示进程名
   (回到默认名 +「(已退出)」)。MCP `list_sessions` 的 `title` 不变(仍是「Terminal N」)。
   **agent 显式命名**(`create_session` 的 `name`;VSCode `createTerminal({ name })` = TitleEventSource.Api):名字固定显示,
   优先级在用户重命名之后、进程名之前 —— 运行中即显示「build (claude)」,不是「zsh (agent)」。agent 会话的后缀是创建时的
   `agentLabel`(如 ` (claude)` / ` (codex)`;未给时 ` (agent)`)。名字与标签由 agent 决定,可见化后显示(换行折成空格,
   控制 / 双向 / 零宽字符显示为「�」,标签超 32、名字超 80 码位中间截断,`lib/untrusted-text`);xterm 输入框读屏名同步。
2. **不显示 OSC 标题**:程序经 OSC 0 / 2 设的标题(`printf '\033]0;T\007'`、oh-my-zsh 每个提示符设的 `user@host: dir`)不影响
   tab 标题 —— renderer 不订阅 xterm `onTitleChange`,没有上报通道(`terminal:update_title` 已移除),会话无 `sequenceTitle` 字段。
   因此开发者 dotfiles 不再左右 tab 标题,e2e 启动环境也不再需要 `DISABLE_AUTO_TITLE`。
3. **前台进程名**(VSCode 初始标题 = shell 可执行文件名;TerminalProcess 非 Windows 每 200ms 轮询 `ptyProcess.process`):
   - 会话登记时即为 spawn 的 shell 名(`/bin/zsh` → `zsh`),首个快照就带上,不先闪「终端 N」;
   - main 每批输出后节流 `PROCESS_TITLE_REFRESH_MS`(200ms)读一次 node-pty 前台进程名,变化才广播;空闲终端不唤醒主进程
     (启动 / 退出程序都伴随输出);读不到(pty 已关闭等)保留 shell 名;
   - 显示名 = 进程名 basename,去掉登录 shell 的 `-` 前缀与 `.exe` 后缀(`-zsh` → `zsh`,`pwsh.exe` → `pwsh`),截到 `LABEL_MAX`;
   - 进程退出 → 清除。Windows 上 node-pty 的 `process` 恒为 shell 文件名 → 显示 shell 名。
   - 关闭确认(confirmOnKill)仍只认 shell 以外的子程序(`runningChildProcess`),与标题分开判定。
4. **重命名**:dock 中终端 tab 的右键菜单首项「重命名…」(三语)→ 激活该终端面板,面板内容显示 design `Modal` 重命名框
   (portal 进面板所在文档,popout 子窗画在子窗),预填当前基础名并全选(菜单关闭时不把焦点还给 tab:`TabMenuEntry.opensFocusedInput`,
   同 Explorer 菜单的 skipOnce);回车 / 「重命名」确定,Esc / 「取消」放弃,
   关闭后焦点回终端。非空 → `terminal:rename` 设 `userTitle`(固定,之后进程名变化不再覆盖);留空 → 清除,回到自动标题;
   原样确定自动名 → 不固定(不发 IPC)。非终端面板的 tab 菜单不出现该项。
5. **范围与持久化**:标题字段存在 main 会话元数据(sessions_changed 广播),与 dock tab 标题同生命周期(会话不跨重启,
   见 terminal-store);tab 的 `aria-labelledby` 指向标题文本,读屏名称随之更新。renderer ingress 校验两个字段为
   ≤ `LABEL_MAX` 的可选字符串。IPC 仅允许本窗口的会话(同其它 terminal IPC)。

## 规范文件

- `title-priority.spec.ts` — 1
- `title-main.spec.ts` — 2 的通道表、3 的 main 侧(登记即 shell 名、输出后节流刷新、显示名规整)、4 的 IPC handler、5 的 ingress
- `title-renderer.spec.tsx` — 2 的 renderer 侧(不订阅 onTitleChange)、4 的 tab 菜单与重命名框
