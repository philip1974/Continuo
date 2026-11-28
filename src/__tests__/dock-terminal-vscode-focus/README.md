# dock / 终端的焦点与组行为对齐 VSCode

行为契约(参考 VSCode 工作台编辑器组 / 集成终端):

1. **有终端在 popout 子窗时新建终端不出错**(`popout-reference.spec.ts`):Reconciler 给新终端找「右侧」参照面板时
   只选 **主窗 grid 中**的终端(popout 组的元素在子窗 body 下,dockview addPanel 以它作参照会抛错;floating 组会把
   新终端并进浮动组)。没有 grid 终端:活动组在 grid → 落在活动组;活动组是 popout(刚弹出过)→ 落在主窗一个可见的
   grid 组(VSCode 新终端默认进主窗面板区)。单个面板加入失败只 `notify.error`
   (`errors.terminal.panel_open_failed`,三语),不中断同一轮其余工作(关闭已删会话的面板、更新标题),也不让
   订阅回调抛错、之后每轮重复失败。
2. **新建终端后焦点直接进 xterm**(`new-terminal-focus.spec.ts`;e2e `terminal-vscode-parity.spec.ts`):新终端
   面板在 setActive 之后才 lazy 挂载,错过了激活事件。xterm 创建(含 0 尺寸推迟创建)那一刻若面板已是活动面板且
   搜索条未开 → 聚焦,焦点在编辑器时 ⌘T 后可直接键入。agent(MCP)创建的会话以「不抢激活」方式加入、不是活动
   面板 → 不抢焦点(VSCode 扩展创建终端默认 preserveFocus)。xterm 创建那一刻所在文档有打开的 Modal(删除确认 /
   授权框等)→ 不抢焦点(见 `hotkey-modal-suppression`)。
3. **关掉活动组 / popout 子窗后激活最近使用的组**(`group-mru.spec.ts`):dockview 默认激活最早的组
   (groups[0])。改为按组的最近使用顺序(MRU)激活下一个存活组;焦点原在被移除的组里时,回落面板的内容获焦(终端
   聚焦 xterm,编辑器等聚焦可编辑元素;焦点在组外只换活动组不抢焦点,见 `focus-after-close`)(VSCode 关闭编辑器组后
   激活最近使用的组)。popout 子窗关闭、面板收回主窗时,收回的面板成为活动面板并获焦(VSCode 辅助窗口关闭后收回的
   编辑器获焦);弹出的就是当前活动面板(弹出前后活动面板不变)时同样成立;从多面板组里弹出活动面板(dockview 此时不派发
   任何活动组 / 活动面板事件,靠组 location 变为 popout 时补记)同样成立。移除的不是活动组 → 不干预。只在**同一窗口**内回落(grid / floating 同属主窗,每个 popout 组各占
   一个子窗):主窗关组不把活动组挪进 popout 子窗,同窗无候选 → 不干预(交给 dockview 默认)。终端聚焦延到 microtask
   且仅当它仍是活动面板:拖动组里最后一个 tab 进另一组时 dockview 照常派发移除事件、随后自己激活目标组,键盘焦点
   不得被送进第三个终端。
   **组内**同样按最近使用回落:活动面板总在组的面板 MRU 首位(VSCode 活动编辑器总是 MRU 第一个)。dockview 每加入一个面板
   (fromJSON 按 tab 顺序恢复、后台加入不激活的面板)都把它排到 MRU 首位 —— 重启后不点 tab 就新建面板再关掉会落到组里最后
   一个 tab、后台加入的终端会插到活动面板前面;跟踪开始(布局恢复之后)时与每次加入面板 / 组之后把活动面板重新置于首位
   (只调整 MRU,不改 tab 顺序、不派发事件、不动焦点与布局写盘)。
4. **活动 tab 总可见**(`active-tab-visible.spec.ts`):活动面板变化、组尺寸变化或 tab 条自身尺寸变化(窗口缩放 /
   分屏)后的下一帧,按实际几何把每个组的活动 tab 滚入 tab 条可见区(比可见区还宽时对齐起点),不留在「⌄N」溢出菜单里
   看不到(dockview 只在激活那一刻按未布局的宽度算一次)。滚入随即同步给 dockview 自绘滚动条,它随后的重算(窗口缩放
   时 tab 条 resize)不把 tab 条滚回原位。活动 tab(无论组里几个 tab)最宽不超过 tab 条可见宽度,窄组里标题截断显示
   省略号,而不是被 tab 条硬裁或整个被挤出。
5. **终端默认名本地化**(`terminal-title-i18n.spec.ts`):未命名终端 main 侧 `title` 仍存英文稳定名 `Terminal N`
   (MCP `list_sessions` 原样给 agent,契约不变),另记 `defaultTitleIndex: N`;renderer 按当前语言显示
   `panels.terminal.default_title`(「终端 N」/「터미널 N」/「Terminal N」),随语言切换更新(含内容未挂载的面板),
   关闭确认框等用面板标题处同步本地化。显式命名的会话按原名显示。store ingress 只收正安全整数序号。
6. **新终端分屏受组最小宽度约束**(`terminal-split-min-width.spec.ts`;e2e `terminal-split-min-width.spec.ts`):新终端
   默认在最后一个 grid 终端右侧分屏;分屏会让组窄于 160px(dockview 向右加组按横排均分)时,改为作为 tab 加入那个
   终端的组(VSCode 终端 / 编辑器组受最小宽度约束),组不会越分越多、压到下限后被挤出窗口右边界。连开 10 个终端,
   每个组都在 dock 内、每个终端都能从 tab 条或「⌄N」到达。之后再把窗口缩窄到放不下全部组的最小宽度时仍会裁切
   (VSCode 网格同样如此),不在本条范围内。
7. **agent 终端聚在一个组**(`agent-terminal-group.spec.ts`):agent(MCP `create_session`)新建的终端,主窗 grid 里已有
   agent 终端时作为 tab 加进最后那个 agent 终端的组;第一个 agent 终端照第 6 条在最后一个终端右侧分屏。此前每个 agent 终端
   都向右再拆一列,几个 agent 终端就把编辑器挤到不足 200px(VSCode 扩展 `createTerminal` 只在终端面板里多一个 tab,
   不拆分)。用户的新建终端(⌘T)与「拆分终端」不受影响。
8. **agent 终端加入不抢 DOM 焦点**(`agent-terminal-keeps-focus.spec.ts`):`addPanelKeepingActive`(agent 终端、非用户意图
   的编辑器面板共用)加面板前记下主窗与原活动组所在文档的焦点元素,加入并还原活动面板后,若焦点已丢失(body / 无 /
   元素已卸载 —— 向右分屏会把原组 DOM 挪进新 split 容器、作为 tab 加入会先藏起原面板内容)且原元素仍在文档里,把焦点
   还给它:用户在编辑器里连续打字时 agent 新建终端,后续按键仍进编辑器(VSCode 扩展 `createTerminal` 不 `show` 时不打断
   输入)。焦点原本就在 body、或已被移到别处(不是丢失)→ 不动。
