# debug-user-controls · 用户接管调试会话 / 调试控制台 / 停下时自动定位

对照 VSCode 运行和调试(`debugToolBar.ts` / `debugCommands.ts` / `breakpointEditorContribution.ts` / `repl.ts` /
`debugSession.ts` 的 stopped 处理与 `debugService.focusStackFrame`)。调试会话仍由 agent 经 MCP `debug.launch` 启动;
本主题让用户在自己的窗口里看到、接管它。

## 1. 调试工具栏 + 按键 + gutter 断点

- 调试视图顶部(会话标题行,VSCode `debug.toolBarLocation: docked` 的位置)有工具栏:继续 / 暂停(同一位置按状态切换)、
  单步跳过、单步调试、单步跳出、停止。按钮按会话状态启用:停住时 继续 / 单步 可用;运行中只有 暂停 / 停止 可用。
  tooltip 为「名称 (键位)」(键位取当前生效绑定),`aria-label` 为名称。点击作用于面板显示的会话(已停住的优先)。
- 命令(命令面板「调试: 继续」等,三语)与默认键照 VSCode(各平台相同):
  `workbench.action.debug.continue` F5(when 已停住)、`.pause` F6(when 运行中)、`.stepOver` F10(when 已停住)、
  `.stepInto` F11(when 有调试会话)、`.stepOut` ⇧F11(when 已停住)、`.stop` ⇧F5(when 有调试会话)。
  when 条件(`inDebugMode` / `debugStopped` / `debugRunning`)与焦点无关、只看本窗口显示的会话;不成立时同键让给后面的绑定
  (无会话时 F5 不做调试动作;不在运行中时 F6 仍是「聚焦下一部分」)。命令面板执行不受 when 限制,按会话状态判定(不可用时无操作)。
- 刻意不做:重启(⇧⌘F5)—— 会话由 agent 启动并归它控制,重新 launch 会换会话 id、脱离 agent。popout 子窗里 F5 被主进程拦截
  (防子窗刷新),F5 继续只在主窗有效;其余键在子窗同样分发。
- 编辑器断点 gutter(行号左侧红点列)左键单击切换该行断点(VSCode 单击 glyph margin):已有红点 → 删除(含 adapter 校正到该行的
  断点),否则新增。Markdown 不显示也不切换。
  - 断点记为**窗口级用户断点**(VSCode 断点不属于某个会话):main 存在内存里(关窗清掉),推 `user-breakpoints-changed`
    (完整列表)给本窗口;subscribe 快照带 `userBreakpoints`。新会话 launch 时在程序起跑前下发;已有会话时同步到本窗口全部
    存活会话(含 agent 启动的),单个会话失败不影响其它。
  - 红点:有会话时显示各会话的断点(adapter 校正后的行),没有会话时显示用户断点。
- 新增 renderer IPC(`debug:control` / `debug:setUserBreakpoint` / `debug:evaluate`)都经 safe-handle + zod 校验,
  只作用于发送方窗口拥有的会话(别的窗口的会话与不存在的同一 `DEBUG_SESSION_NOT_FOUND`);用户在自己的窗口操作,不经 agent
  授权弹窗。
- 用户与 agent 同时操作时状态一致:界面只按 main 推的事件刷新(`started` / `stopped` / `continued` / `breakpoints-changed` /
  `terminated`),工具栏动作不做乐观更新。会话 launch 完成即推 `started`,面板与工具栏立刻显示运行中的会话。
- DebugService 新增:`pause`(DAP pause;已停住为无操作,程序未起跑报错)、`removeBreakpoint`(按请求行或校正后行删除,
  下发该 source 剩余集合)、`setUserBreakpoint`。

## 2. 调试控制台

- main 订阅 DAP `output` 事件(telemetry 不收,category 缺省 console),去 ANSI、单条按 16 KiB 截断,按会话写入环形缓冲
  (10000 条 / 2 MiB,丢最旧;seq 从 0 递增不回退),每 50ms 合批推 `output` 事件(会话结束 / 拆除前先推完)。
- 调试视图「调试控制台」页:显示最近 1000 行(更早的提示未显示),stdout 常规色、stderr / 求值失败错误色、console 类别警告色;
  新输出到达时若已在底部则跟随。底部输入框 Enter 求值(DAP evaluate context=repl,停住时在首帧求值),输入与结果追加到控制台。
  会话结束后保留该会话的控制台(标「已结束」),直到下一个会话开始。重载后 subscribe 快照带最近的输出。
- MCP 工具 `debug.read_output`(同其它 `debug.*`:须本调用方创建的会话、debug 授权域):`since_seq`(默认 0)起读,
  `max_bytes`(默认 64 KiB,上限 1 MiB;至少返回一条,单条超限截短)。返回 `entries[{seq, category, output}]`、`next_seq`、
  `truncated`(since_seq 之后有输出已被丢弃)、`has_more`。程序结束后、disconnect 之前仍可读。

## 3. 停下时自动定位

- 每一停(经 `stopped` 事件实时到达的;subscribe 快照恢复的不算)等首帧位置到达后:以预览方式在编辑器打开该文件、该行滚到中间,
  **不抢焦点**(刻意差异:VSCode `debug.focusEditorOnBreak` 默认聚焦编辑器;这里会话多由 agent 驱动,用户可能正在别处打字)。
  打开期间焦点被挪到 body / 编辑器 → 还给原来的元素。
- 因断点停下(reason=breakpoint)时显示调试视图(VSCode `debug.openDebug` 默认 `openOnDebugBreak`):没有 → 在侧栏新建
  (不换活动组),有但被同组别的 tab 盖住 → 切到它(不激活该组)。
- 调试视图是侧栏型面板(同搜索,VSCode 调试视图在侧栏):⇧⌘D / 自动打开都落在侧栏组(已有侧栏组 → 作为 tab 加进去,否则主窗
  网格最左侧),不和编辑器在同一组 —— 点调用栈帧打开文件时调试视图不会被盖住。
- 多次快速停下只定位最新一停:旧停的栈帧到达时已不是当前停点即跳过;继续运行后到达的不定位。
