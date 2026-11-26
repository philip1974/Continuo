# open-panel-focus(用户打开 / 显示面板后焦点进面板)

VSCode:`workbench.view.output` / `workbench.view.debug` 等「显示视图」命令以 `openView(id, focus=true)` 打开,
焦点落在该视图;`⌘,` 不论设置编辑器是新开还是已在后台 tab,总是聚焦设置搜索框;按快捷键打开视图后立刻打字不丢字。

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/panel-focus.ts` | `focusPanelContentWhenReady`:微任务里把焦点交给面板内容;内容尚未渲染出落点(新建面板 / lazy chunk 挂起中)→ 观察内容 DOM,出现落点再聚焦;焦点已在内容里(面板自己 autoFocus / requestFocus)不再移动;面板已不是活动面板、用户按下指针、超时 → 放弃。`[data-panel-focus-root]` 是无控件面板的根落点 |
| `src/shell/dock/dock-api-ref.ts` | 用户入口的唯一落点:`revealDockPanel`(激活已有面板,主窗 / popout 子窗都交焦点)与 `addPanelAndFocus`(新建后交焦点);`openOrFocusPanelNow` / `openOrFocusPanel` 走它们 |
| `src/shell/dock/dock-panel-actions.ts` | `showPanelOfType`(查看:显示输出 / 显示调试)走同一落点 |
| `src/shell/dock/HeaderActions.tsx` | dock「⋯」菜单:多实例面板(输出 / 调试)新建走 `addPanelAndFocus`,单例走 `openOrFocusPanelNow` |
| `src/panels/Output.tsx` | 空输出面板的根 `tabIndex=-1` + `data-panel-focus-root`(无任何控件时焦点仍进面板) |
| `src/lib/lazy-panel.tsx` | `preloadableLazy`:预取完成后首次渲染直接用已加载的组件,不经 Suspense 挂起(React 挂起后至少 ~300ms 才揭示内容) |
| `src/core-plugins/SearchPlugin.ts` / `SettingsPanelPlugin.ts` | 面板组件经 `preloadableLazy`,导出 `preloadSearchPanel` / `preloadSettingsPanel` |
| `src/core-plugins/lazy-category-tab.ts` | 设置默认分类页签内容同经 `preloadableLazy`,随设置预取一并预取(外壳挂载后分类内容不再另挂起) |
| `src/main-app.ts` | 启动后空闲时(`requestIdleCallback`)预取 ⇧⌘F / ⌘, 两个面板 chunk |

## 行为

### 1. 打开 / 显示面板后焦点进面板(`open-panel-focus.spec.tsx`)

- 打开新面板(⌘, / ⇧⌘F / 「⋯」单例 / 插件 `app.dock.openPanel`)→ 面板内容获焦(终端里的焦点移走)
- 新面板内容稍后才渲染(lazy chunk / dockview 门户)→ 渲染出落点时获焦
- 等待期间用户按下指针 / 激活了别的面板 → 不抢焦点
- 面板已把焦点放进自己内容里(autoFocus / 自己的 requestFocus)→ 不改到别的控件
- 已存在但在同组后台 tab 的设置面板,⌘, 重新激活 → 设置搜索框获焦
- 「查看:显示输出」:新建 / 激活已有输出面板 → 焦点进输出面板
- dock「⋯」菜单选「输出」(多实例,新建)→ 焦点进新输出面板
- 空输出面板没有控件 → 焦点落在面板根(`data-panel-focus-root`)
- 后台 / agent 建面板(MCP 建终端经 DockReconciler、会话恢复)不经这些入口,不抢焦点(既有规则不变)

### 2. 冷启动按 ⇧⌘F / ⌘, 后立刻打字不丢字(`panel-chunk-preload.spec.tsx`)

- `preloadableLazy`:预取完成后挂载不经 Suspense 回退、同步渲染出内容;预取前照常挂起
- 预取前挂载(走 lazy)的实例在模块加载后父组件重渲染时不换组件类型、不重挂(状态保留)
- 搜索 / 设置面板经 `preloadableLazy`,启动后空闲时预取(与面板 lazy 共用同一加载器 → 同一 chunk)
- 设置的分类页签内容同经 `preloadableLazy`,设置预取时一并预取(设置外壳同步挂载后,分类内容不再另挂起约 300ms)
