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
  断点),否则新增。只有能设断点的文件(JS / TS:`.js .mjs .cjs .jsx .ts .mts .cts .tsx`,不分大小写;`canSetBreakpointsIn`)
  gutter 才显示手形指针、点击才切换 —— VSCode `debug.allowBreakpointsEverywhere` 默认 false,只有调试器声明了 breakpoints 的语言
  能设(js-debug 声明 javascript / typescript / javascriptreact / typescriptreact,另有 html / wat / c / cpp / rust / zig / fsharp
  属浏览器 / wasm 调试,Continuo 不启动,刻意不收)。Markdown / JSON / CSS 等无操作。main 同一判定:别的文件
  `setUserBreakpoint(enabled)` 报 `BAD_INPUT`(删除照常);launch 下发用户断点时也只发这些文件的。
- 断点 gutter 标记:断点红点、当前执行行黄箭头;**同一行两者都有 → 组合标记**(箭头里嵌红点,VSCode
  `codicon-debug-breakpoint.codicon-debug-stackframe` 的箭头 + 内嵌圆点),红点不被箭头盖住。各标记带 `title` / `aria-label`
  (断点 / 当前执行行 / 断点，当前执行行;三语)。颜色取 `--color-debug-breakpoint` / `--color-debug-exec-marker`(light / dark 都有值)。
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
- 调试视图「调试控制台」页:显示最近 1000 行(更早的提示未显示),stdout 常规色、stderr / 求值失败错误色、console 类别警告色,
  且不只靠颜色:每行左侧 2px 竖条位,stderr / error 实线、console / important 虚线、stdout 透明占位(色觉差异 / 强制颜色下可辨;
  VSCode REPL 只靠颜色,刻意增强);
  新输出到达时若已在底部则跟随。底部输入框 Enter 求值(DAP evaluate context=repl,停住时在首帧求值),输入与结果追加到控制台。
  - REPL(VSCode Debug Console):输入框 ↑ / ↓ 翻输入历史(VSCode `navigateHistory`:↑ 上一条、到最早一条停住;↓ 下一条、过了最新
    一条清空;本次启动内各会话共用、最近 100 条、连续重复只记一次;读屏播报取出的内容)。
  - 求值结果是对象(evaluate 回 `variables_reference > 0`)→ 结果行是可展开的树节点(同变量树:点击 / Enter / → 展开,子变量经
    `debug:getVariables` 懒加载,同一停内缓存)。reference 只在求值时的那一停有效:继续运行 / 下一停后该行退回纯文本。
  - 控制台工具栏「清除控制台」按钮(清当前会话的控制台,会话已结束时清保留的那份);mac 上焦点在控制台里时 ⌘K 同样清除
    (VSCode `workbench.debug.panel.action.clearReplAction`:mac ⌘K when focusedView=REPL,其它平台无默认键)—— 就地处理并拦下,
    不落到全局分发表里的终端 ⌘K「清除终端」。刻意简化:该键不进命令注册表(不可改绑)。
  会话结束后保留该会话的控制台(标「已结束」),直到下一个会话开始。重载后 subscribe 快照带最近的输出。
- MCP 工具 `debug.read_output`(同其它 `debug.*`:须本调用方创建的会话、debug 授权域):`since_seq`(默认 0)起读,
  `max_bytes`(默认 64 KiB,上限 1 MiB;至少返回一条,单条超限截短)。返回 `entries[{seq, category, output}]`、`next_seq`、
  `truncated`(since_seq 之后有输出已被丢弃)、`has_more`。程序结束后、disconnect 之前仍可读。

## 3. 停下时自动定位

- 每一停(经 `stopped` 事件实时到达的;subscribe 快照恢复的不算)等首帧位置到达后按**来源**处理:
  - **用户自己的调试操作**引起的(本窗口调试工具栏 / F5 F6 F10 F11 ⇧F11 发出 继续 / 暂停 / 单步 后到达的第一停,
    `lastLiveStop.byUser`;发出前登记,发送失败 / 会话结束撤销):照 VSCode(`debug.focusEditorOnBreak` 默认 true,
    `StackFrame.openInEditor` 在活动组打开)以预览方式在活动编辑器组打开该文件、该行滚到中间,**焦点进编辑器**。
  - **其它**(agent 经 MCP 驱动、程序自己撞上断点):不抢焦点,且**不换下 / 盖住焦点所在的面板或编辑器**(刻意差异:VSCode 的终端
    在独立面板区,打开停止位置盖不住它;这里终端与编辑器可在同一 dock 组):
    - 在活动编辑器组打开不会盖住焦点所在面板(焦点不在 dock 面板里,或焦点面板在另一个 dock 组)→ 照旧在活动组打开(不抢焦点);
    - 会盖住(焦点就在活动编辑器组里 —— 换 tab 会换下正在打的文件、同文件会挪光标;或焦点面板与活动编辑器组同在一个 dock 组 ——
      激活编辑器面板会盖住终端;或编辑器面板已被关掉)→ 改投另一个**正在显示、且不与焦点面板同组**的编辑器组,后台打开
      (`OpenFileOptions.requestFocus:false`:不换活动编辑器组、不激活 dock 面板、不计入用户激活代际)并把该行滚到中间;
      没有这样的组 → **不打开**(执行行装饰在已打开的视图里照常更新,调试视图照常显示调用栈)。
    - 打开期间焦点被挪到 body / 编辑器 → 还给原来的元素;原元素已被卸载、焦点落在 body → 交给活动编辑器,按键不落空。
  - 已知局限:来源按「本窗口用户最近一次发出的操作之后的第一停」判定,用户按 F5 继续后 agent 再发 pause 造成的那一停会算作用户的。
- 因断点停下(reason=breakpoint)时显示调试视图(VSCode `debug.openDebug` 默认 `openOnDebugBreak`):没有 → 在侧栏新建
  (不换活动组),有但被同组别的 tab 盖住 → 切到它(不激活该组)。非用户引起的停下:要切到 / 新建进的组正是焦点所在面板的组
  (如用户正在侧栏资源管理器里操作)→ 不做(`keepFocusedVisible`)。
- 调试视图是侧栏型面板(同搜索,VSCode 调试视图在侧栏):⇧⌘D / 自动打开都落在侧栏组(已有侧栏组 → 作为 tab 加进去,否则主窗
  网格最左侧),不和编辑器在同一组 —— 点调用栈帧打开文件时调试视图不会被盖住。
- 多次快速停下只定位最新一停:旧停的栈帧到达时已不是当前停点即跳过;继续运行后到达的不定位。
