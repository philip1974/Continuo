# explorer-toggle-sidebar(VSCode ⌘B 同款)

行为契约:**`ExplorerTabPlugin` 在 onload 时注册一条命令
`explorer.toggleSidebar`,默认 hotkey `mod+b`,触发时(`toggleSidebarVisibility`)切换左侧 Explorer 侧栏的
`sidebarOpen`;隐藏的侧栏里有焦点时把焦点交给活动 dock 面板。**

> 旧路径:只能点 IconSidebar 的 Folder 图标 toggle。本主题加全局 hotkey,
> 与 VSCode `workbench.action.toggleSidebarVisibility`(⌘B / Ctrl+B)对齐。

## 模块

| 文件 | 职责 |
|---|---|
| `src/core-plugins/ExplorerTabPlugin.ts` | 注册 `explorer.toggleSidebar` 命令 + `mod+b` hotkey |
| `src/panels/Explorer/explorer-commands.ts` | `toggleSidebarVisibility`:切换 + 焦点转移 |
| `src/stores/layout-ui.store.ts` | `sidebarOpen` / `toggleSidebar` |

## 关键行为

### 命令注册

- bootCorePlugins 后,`coApp.commands.getAll()` 含 id=`explorer.toggleSidebar`
- `category` = 'Explorer'
- `title` 含「Explorer」「侧栏」字样(命令面板搜索可命中)
- `hotkey` = 'mod+b'

### fn 行为

- 起始 `sidebarOpen=true` → 调 fn → `sidebarOpen=false`
- 再调 fn → `sidebarOpen=true`(toggle 幂等可重复)

### 焦点(VSCode:隐藏含焦点的侧栏 → 活动编辑器获焦)

- 焦点在侧栏(`aside[data-workbench-part=sidebar]`,如资源管理器树)里时隐藏 → 焦点交给活动 dock 面板(同 F6 的 dock
  落点:`focusWorkbenchPart('dock')`,活动面板在子窗时取主窗最近使用的组,主窗无面板时落主窗空态),不落 body
- 焦点不在侧栏里(编辑器 / 状态栏等)→ 隐藏不移动焦点
- 显示侧栏不抢焦点(焦点留在原处,VSCode 同)

### Hotkey 路由

- 由 `useCommandHotkeys` 监听:全局 `mod+b` keydown → 派发 `explorer.toggleSidebar`
- 本 spec 只验证 spec 上 hotkey 字段正确;hotkey → keydown 路由由
  `command-hotkeys` / `use-command-hotkeys` 主题持有,不重复测

## 不在本主题验证

- IconSidebar 上的 Folder 按钮点击 toggle — 已由 `icon-sidebar` 主题持有
- ExplorerSidebar 在 `sidebarOpen=false` 时返回 null — 已由 `explorer-sidebar` 主题持有
- `useLayoutUiStore` API 形态(默认值 / clamp 宽度)— 已由 `explorer-sidebar` 持有
