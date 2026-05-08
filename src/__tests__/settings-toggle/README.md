# settings-toggle(⌘, 切换 Settings panel,VSCode `Toggle` 风)

行为契约:**`settings.toggle` 命令(⌘,/ IconSidebar 齿轮 / 命令面板)
统一走 `toggleSettingsPanel()` helper。helper 实现 toggle 语义:**

* **panel 不存在** → 打开 + `setSidebarOpen(false)` 收起 Explorer 侧栏(让 Settings 拿到更宽空间)
* **panel 存在且 `api.isActive=true`**(用户正看着 Settings)→ `panel.api.close()` **关闭**(再次按 ⌘, 收回)
* **panel 存在但 `api.isActive=false`**(被其他 tab 遮住)→ `setActive()` 聚焦 + 收起侧栏
* **dock 未就绪**(开机时序)→ 静默忽略,无副作用

> 与 VSCode 不同的是收侧栏(VSCode `⌘,` 不联动 sidebar)。Continuo 的 Settings panel 内部已是「左导航 + 右内容」两栏,再叠 Explorer 侧栏会被挤窄。

> 关闭 Settings panel 后 sidebar **不自动恢复** — 用户在 Settings 打开期间可能已手动展开,关闭时强行还原会覆盖用户意图。

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/toggle-settings-panel.ts` | `toggleSettingsPanel()` helper(SOT) |
| `src/core-plugins/SettingsPanelPlugin.ts` | `settings.toggle` 命令(⌘,)fn 调 helper |
| `src/shell/IconSidebar.tsx` | 齿轮按钮 onClick 调 helper |
| `src/shell/dock/dock-api-ref.ts` | `getDockApi()` 单例 |
| `src/stores/layout-ui.store.ts` | `setSidebarOpen` |

> 所有 Settings 入口(命令面板 / ⌘, / IconSidebar 齿轮 / 未来入口)都走 helper,
> toggle 语义与 sidebar 副作用集中,不会漏。新加入口必须调 helper,
> 不要直接 `openOrFocusPanel`。

## 关键行为

### 命令注册

* `coApp.commands.getAll()` 含 id=`settings.toggle`
* `category='Settings'`、`hotkey='mod+,'`

### dock 未就绪

* `getDockApi()=null` → helper 直接 return,`sidebarOpen` 不变,无 panel 操作

### panel 不存在

* `getPanel('settings')=null` → `addPanel({id:'settings',component:'settings',title:'Settings'})`
* 同步 `setSidebarOpen(false)`(无论起始值)

### panel 已存在 + active

* `existing.api.isActive=true` → `existing.api.close()`
* **不**改 `sidebarOpen`(关 Settings 不应同时关 sidebar)

### panel 已存在 + inactive

* `existing.api.isActive=false` → `existing.api.setActive()`
* `setSidebarOpen(false)`(让出空间)

## 不在本主题验证

* SettingsPanel 内部 UI — `settings-panel` 持有
* `explorer.toggleSidebar` 命令(⌘B)— `explorer-toggle-sidebar` 持有
* IconSidebar Folder 按钮 toggle — `icon-sidebar` 持有
* hotkey → keydown 路由 — `command-hotkeys` / `use-command-hotkeys` 持有
