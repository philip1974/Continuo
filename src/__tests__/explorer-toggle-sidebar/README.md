# explorer-toggle-sidebar(VSCode ⌘B 同款)

行为契约:**`ExplorerTabPlugin` 在 onload 时注册一条命令
`explorer.toggleSidebar`,默认 hotkey `mod+b`,触发时调
`useLayoutUiStore.getState().toggleSidebar()` 切换左侧 Explorer 侧栏的
`sidebarOpen`。**

> 旧路径:只能点 IconSidebar 的 Folder 图标 toggle。本主题加全局 hotkey,
> 与 VSCode `workbench.action.toggleSidebarVisibility`(⌘B / Ctrl+B)对齐。

## 模块

| 文件 | 职责 |
|---|---|
| `src/core-plugins/ExplorerTabPlugin.ts` | 注册 `explorer.toggleSidebar` 命令 + `mod+b` hotkey |
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

### Hotkey 路由

- 由 `useCommandHotkeys` 监听:全局 `mod+b` keydown → 派发 `explorer.toggleSidebar`
- 本 spec 只验证 spec 上 hotkey 字段正确;hotkey → keydown 路由由
  `command-hotkeys` / `use-command-hotkeys` 主题持有,不重复测

## 不在本主题验证

- IconSidebar 上的 Folder 按钮点击 toggle — 已由 `icon-sidebar` 主题持有
- ExplorerSidebar 在 `sidebarOpen=false` 时返回 null — 已由 `explorer-sidebar` 主题持有
- `useLayoutUiStore` API 形态(默认值 / clamp 宽度)— 已由 `explorer-sidebar` 持有
