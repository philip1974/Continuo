# ExplorerSidebar(VSCode 风固定侧边栏)

行为契约:**`<ExplorerSidebar />` 在 `sidebarOpen=true` 时挂出,宽度由 store.sidebarWidth 控制;
右边 4px 拖拽条调用 useColumnResize 改宽度。`sidebarOpen=false` → 用户看过的文件树保持挂载但隐藏
(aside `hidden`),其余情况不渲染。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/ExplorerSidebar.tsx` | UI |
| `src/stores/layout-ui.store.ts` | sidebarOpen/Width state |

## 关键行为

### sidebarOpen=false

- 从未对用户显示过文件树(启动即关闭 / 首帧 root 未 hydrate 而 hydrate 后关闭 / 无 workspace)→ 不渲染(返 null)
- 打开过且 root 未变 → 保活:aside `hidden`,FolderTree 不卸载(不 unwatchDir,重开不重新 listDir/watchDir,
  滚动位置保留);拖拽条与宽度订阅卸载;`ExplorerVisibleContext=false` 下传
- 隐藏期间换 root → 卸载旧树、不在隐藏态挂载新树,直到再次打开
- 规范:`explorer-sidebar-keepalive.spec.tsx`
- 隐藏时关闭 Explorer 弹出菜单(Header「更多操作」、文件行右键菜单,二者都 portal 到 body):
  菜单节点移除、body 无 Radix 模态 `pointer-events:none` 残留;再显示不自动重开,之后可正常再次打开
- 规范:`explorer-sidebar-hidden-menus.spec.tsx`

### sidebarOpen=true

- 渲染 <aside style={ width }>
- 内含 <Explorer />(无 workspace 时为 EmptyWorkspace)
- 拖拽条 div(cursor-col-resize)

### 窄窗口让位(同 VSCode)

- 显示宽度 = clamp(`SIDEBAR_MIN_WIDTH`, `sidebarWidth`, 侧栏可用宽 − max(`EDITOR_MIN_WIDTH`, dock 网格最小宽));可用宽 =
  窗口宽 − 侧栏左边缘,监听窗口 resize 与 dock 布局变化重算。`EDITOR_MIN_WIDTH` = 220,取 VSCode 编辑区最小宽度
  (`DEFAULT_EDITOR_MIN_DIMENSIONS.width`);dock 网格最小宽读 dockview `DockviewApi.minimumWidth`(并排的组相加、叠放的取大,
  组默认 100,另设约束的组按其约束)—— 读实际值,不写死组数 × 100
- 窗口窄到放不下侧栏最小宽 + 编辑区最小宽时,侧栏停在最小宽(不再继续缩)
- 侧栏缩到最小宽后 dock 网格仍放不下(可用宽 − `SIDEBAR_MIN_WIDTH` < dock 最小宽,如 400 宽窗口里两组并排)→ 侧栏收起
  (`sidebarOpen=false`,同 ⌘B 隐藏:侧栏里的焦点交给活动 dock 面板),最右的组与其「⋯ / 弹出」按钮不被裁到窗口外。
  对应 VSCode 侧栏 snap(`SidebarPart.snap = true`:放不下最小宽 170 时整个收起;VSCode 窗口缩放本身不收起侧栏,网格按最小宽
  溢出 —— 这里把 snap 用到窗口缩放上)。只在「放得下 → 放不下」的变化时收起:用户在窄窗口里再打开侧栏不会被立刻收回;
  单组时 dock 最小宽 100,400 宽窗口仍保留最小宽侧栏(e2e `explorer-sidebar-narrow-window`)
- 布局恢复造成的「放得下 → 放不下」不算(第五十三轮审计 3:1000 宽拆 4 组 → 缩到 600 自动收起 → ⌘B 打开 → 重启,侧栏被收起并把
  `sidebarOpen:false` 写回 explorer.json):dock 布局恢复(fromJSON / 默认布局,`markDockLayoutRestored`)之前网格是空的(最小宽 0)、
  popout 恢复在途时开窗失败的组会被收回主窗网格、同一窗口切换 root 后按文件夹快照恢复编辑器组(`rootSwitchesPending > 0`)——
  这些期间不记基准并清掉旧基准,恢复完成后按当时的结果重新记(放不下 = 侧栏保持打开,之后放大再缩窄才收起)。
  e2e `explorer-sidebar-narrow-window` › 重启保持
- 保存的 `sidebarWidth` 不因窗口变窄改写,窗口放大后恢复
- separator `aria-valuemax` / `aria-valuenow` 为有效上限 / 显示宽度;键盘与拖拽以显示宽度为起点、有效上限为上限
- 规范:`explorer-sidebar-window-clamp.spec.tsx`

### 宽度变化的渲染隔离(perf)

- 拖拽/键盘改 sidebarWidth 只重渲侧栏外壳(aside 宽度、separator aria-valuenow)
- `Explorer`(memo,无 props,只订阅 workspace root)及其 FolderTree 子树不因宽度变化重渲
- root 变化仍驱动 Explorer 重渲
- 规范:`explorer-sidebar-render-isolation.spec.tsx`
