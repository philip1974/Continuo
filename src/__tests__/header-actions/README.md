# HeaderActions(Dockview group header 自定义按钮)

行为契约:**Dockview header 右侧两个 IconButton:popout(弹出活动 panel 到独立窗口) +
更多操作菜单(列出 PanelRegistry 全部 panel 类型,点击 addPanel 到当前 group)。
activePanel=null 时 popout 按钮 disabled;popout 窗口内(组 `group.api.location.type === 'popout'`)不显示 popout 按钮。点更多 → 切 menu;点 menu 外 pointerdown → 关菜单。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/HeaderActions.tsx` | UI |
| `src/plugins/registries/PanelRegistry.ts` | 可选 panel 类型(`multiInstance` 单例/多实例标记) |
| `src/shell/dock/dock-api-ref.ts` | `openOrFocusPanelNow`(单例打开/聚焦) |

## 关键行为

### popout 按钮

- activePanel=null → disabled
- activePanel 有 → 点击调 containerApi.addPopoutGroup(activePanel, { popoutUrl })
- addPopoutGroup reject **或** resolve false(弹窗被拦截)→ notify.error(`shell.dock.popout_failed`)

### 更多操作菜单

- 默认关闭(open=false)
- 点击切换 open
- open=true → role=menu 渲染 PanelRegistry.getAll() 每条
- 点 menu item → 按 PanelSpec 打开 + 关菜单(terminal 类型改走 `createUserTerminal`;菜单打开期间该类型已被注销 → 只关菜单,不创建)
- **单例类型**(PanelSpec 未声明 `multiInstance: true`:editor / settings / 插件面板)→ 按固定 id = type
  打开(`openOrFocusPanelNow`,新建时落在菜单所在 group):已有同 id 面板 → 只聚焦,不另开。与 ⌘, toggle、
  DockShell editor 激活、`app.dock.openPanel` 用同一 id,故 ⋯ 打开的 Settings 能被 ⌘, 关闭,不会出现两个 EditorPanel
- **多实例类型**(`multiInstance: true`:terminal / output / debug)→ containerApi.addPanel({ id, component, title, position }),
  panel id 自增计数(同 type 多次点产生不同 id);生成的 id 已被现有面板占用(计数器每次启动归零,
  而持久化布局会恢复旧 id)→ 跳到下一个空闲 id
- addPanel 抛错 → 菜单仍关闭 + notify.error(`shell.dock.add_panel_failed`)

### 关闭菜单

- 文档 pointerdown 在 ref 之外 → 关菜单

### subscribe panels

- coApp.panels.subscribe → 注册新 panel 类型立即出现在 menu 里

- 恢复布局时关闭单例类型中 id ≠ type 的旧实例(`closeDuplicateSingletonPanels`,DockShell onReady 中与清理旧 explorer
  面板同处):旧版「⋯」菜单多开出的 `editor-1` / `settings-1` 不再恢复;多实例类型与未注册类型(插件尚未加载)不动。
