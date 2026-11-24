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
   (groups[0])。改为按组的最近使用顺序(MRU)激活下一个存活组,是终端则聚焦 xterm(VSCode 关闭编辑器组后激活
   最近使用的组)。popout 子窗关闭、面板收回主窗时,收回的面板成为活动面板并获焦(VSCode 辅助窗口关闭后收回的
   编辑器获焦)。移除的不是活动组 → 不干预。只在**同一窗口**内回落(grid / floating 同属主窗,每个 popout 组各占
   一个子窗):主窗关组不把活动组挪进 popout 子窗,同窗无候选 → 不干预(交给 dockview 默认)。终端聚焦延到 microtask
   且仅当它仍是活动面板:拖动组里最后一个 tab 进另一组时 dockview 照常派发移除事件、随后自己激活目标组,键盘焦点
   不得被送进第三个终端。
4. **活动 tab 总可见**(`active-tab-visible.spec.ts`):活动面板变化、组尺寸变化(窗口缩放 / 分屏)后的下一帧,按实际
   几何把每个组的活动 tab 滚入 tab 条可见区(比可见区还宽时对齐起点),不留在「⌄N」溢出菜单里看不到(dockview 只在
   激活那一刻按未布局的宽度算一次)。组里只有一个 tab 时,活动 tab 随组变窄收缩、标题截断显示,而不是整个被挤出。
5. **终端默认名本地化**(`terminal-title-i18n.spec.ts`):未命名终端 main 侧 `title` 仍存英文稳定名 `Terminal N`
   (MCP `list_sessions` 原样给 agent,契约不变),另记 `defaultTitleIndex: N`;renderer 按当前语言显示
   `panels.terminal.default_title`(「终端 N」/「터미널 N」/「Terminal N」),随语言切换更新(含内容未挂载的面板),
   关闭确认框等用面板标题处同步本地化。显式命名的会话按原名显示。store ingress 只收正安全整数序号。
