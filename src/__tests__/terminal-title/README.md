# terminal-title — 终端 tab 标题:进程名 / OSC 标题 / 重命名

对齐 VSCode 集成终端的标题来源(`TerminalInstance._setTitle` 的 `TitleEventSource`;默认 `terminal.integrated.tabs.title` = `${process}`;
程序标题 `${sequence}`;终端 tab 右键「重命名…」= `workbench.action.terminal.rename`)。

## 行为契约

1. **基础名优先级**(`terminalPanelTitle` / `terminalBaseTitle`,DockReconciler 与 TerminalPanelView 共用):
   用户重命名 > 前台程序名(shell 以外,如 `vim` / `node`)> 程序经 OSC 0 / 2 设的标题 > 默认名「终端 N」(按当前语言)/
   显式 session 标题。agent 会话仍加 ` (agent)` 后缀,已退出仍加「(已退出)」;已退出时不再显示前台程序名。
   - 与 VSCode 的偏离:空闲(前台只有 shell)时 VSCode 显示 shell 名(`zsh`),这里保留「终端 N」(编号区分多个终端;
     MCP `list_sessions` 的 `title` 不变)。
2. **OSC 标题**:xterm `onTitleChange`(OSC 0 / 2,如 `printf '\033]0;MYTITLE\007'`、vim、oh-my-zsh 提示符)→
   `terminal:update_title` → main 会话 `sequenceTitle`。同 cwd 上报一样尾随合并去重(历史回放会把标题重放一遍),
   超长截到 `LABEL_MAX`;空标题清除。oh-my-zsh 等每个提示符都设标题(`user@host: dir`)的 shell 配置下,空闲 tab 显示该标题
   (同 iTerm2 / Terminal.app;用户可设 `DISABLE_AUTO_TITLE=true` 关闭);e2e 启动环境为此设了 `DISABLE_AUTO_TITLE`。
3. **前台进程名**(VSCode TerminalProcess 非 Windows 每 200ms 轮询 `ptyProcess.process`):main 每批输出后节流
   `PROCESS_TITLE_REFRESH_MS`(200ms)读一次 node-pty 前台进程名(与关闭确认同一判定 `runningChildProcess`,shell 本身 →
   无),变化才广播;空闲终端不唤醒主进程(启动 / 退出程序都伴随输出)。进程退出 → 清除。Windows 上 node-pty 的
   `process` 恒为 shell → 不显示(同关闭确认)。
4. **重命名**:dock 中终端 tab 的右键菜单首项「重命名…」(三语)→ 激活该终端面板,面板内容显示 design `Modal` 重命名框
   (portal 进面板所在文档,popout 子窗画在子窗),预填当前基础名并全选(菜单关闭时不把焦点还给 tab:`TabMenuEntry.opensFocusedInput`,
   同 Explorer 菜单的 skipOnce);回车 / 「重命名」确定,Esc / 「取消」放弃,
   关闭后焦点回终端。非空 → `terminal:rename` 设 `userTitle`(固定,之后 OSC / 进程名不再覆盖);留空 → 清除,回到自动标题;
   原样确定自动名 → 不固定(不发 IPC)。非终端面板的 tab 菜单不出现该项。
5. **范围与持久化**:标题字段存在 main 会话元数据(sessions_changed 广播),与 dock tab 标题同生命周期(会话不跨重启,
   见 terminal-store);tab 的 `aria-labelledby` 指向标题文本,读屏名称随之更新。renderer ingress 校验三个字段为
   ≤ `LABEL_MAX` 的可选字符串。IPC 仅允许本窗口的会话(同其它 terminal IPC)。

## 规范文件

- `title-priority.spec.ts` — 1
- `title-main.spec.ts` — 2 / 3 / 4 的 main 侧(会话字段、IPC handler、进程名刷新)、5 的 ingress
- `title-renderer.spec.tsx` — 2 的 renderer 上报、4 的 tab 菜单与重命名框
