# 标题栏 / 状态栏 / 窗口标题跟随活动面板(VSCode 对齐)

VSCode 编辑区里活动的是终端等非文本编辑器时,窗口标题取该编辑器的名称,编辑器专属的状态栏项(行列、编码等)隐藏。
Continuo 的编辑器(所有文件 tab)是一个 dock 面板,终端 / 设置 / Debug / 插件面板与它并列;此前标题栏与状态栏只看编辑器
内部的活动 tab:打开 README.md 再切到终端,标题栏仍是「README.md · ws」,状态栏仍是「README.md 169 行 · 333 词…」。

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/main-window-active-panel.ts` | `useActiveNonEditorPanel()`:订阅主窗活动的 dock 面板(id + 标题,含改名 / 语言切换);非编辑器 → 该面板,否则 null |
| `src/shell/dock/dock-api-ref.ts` | `subscribeDockApi`:dock api 出现 / 更换 / 卸载时通知 |
| `src/shell/dock/main-window-active-panel.ts` | `useMainWindowEditorGroupId()`:主窗正显示的编辑器组(标题 / 状态栏取它的活动 tab) |
| `src/shell/dock/popout-window-titles.ts` | `trackPopoutWindowTitles(api)`(DockShell onReady 挂载):popout 子窗原生标题 = 子窗自己的活动文件 / 面板 |
| `src/shell/window-title.ts` | 窗口标题拼接「文件 ● · 工作区」/ `Continuo`(主窗与子窗共用) |
| `src/shell/TitleBar.tsx` | 标题栏文本与 `document.title`(窗口标题) |
| `src/shell/StatusBar.tsx` | 非编辑器面板活动时隐藏文件名与统计 |

## 行为(`chrome-active-panel.spec.tsx`)

- 编辑器面板活动 → 标题栏「文件 ● · 工作区」,状态栏文件名 + 行 / 词 / 字符(原行为)
- 终端 / 设置 / Debug / 插件面板活动 → 标题栏「面板名 · 工作区」(无 dirty 标记、tooltip 为工作区路径);状态栏不显示
  文件名与统计;其余项(工作区、MCP、agent、插件项)照常
- 面板标题变化(终端改名、切换界面语言)→ 标题随之更新;切回编辑器 → 恢复文件
- 窗口标题 `document.title` 与标题栏一致(「a · b」,无 workspace 且无活动项时为 `Continuo`);Electron 窗口标题随之
- dock 尚未就绪 / 编辑器面板尚未建出 → 按活动编辑器组的活动 tab 显示(启动期不闪)
- 活动面板在 popout 子窗 → 取主窗最近使用的组的活动面板
- **窗口标题按窗口分别计算**(VSCode 同;`popout-window-titles.spec.tsx`):主窗的文件取**主窗正显示的编辑器组**的活动 tab,
  不取全局活动 tab —— 活动编辑器组在子窗(⌘` 切到子窗、重启恢复挂上子窗)时主窗标题栏 / 状态栏 / 窗口标题仍是主窗的文件;
  子窗组切换 / 改动不影响主窗;主窗没有面板(全部弹出)→ 主窗只显示工作区
- popout 子窗没有自己的标题栏 / 状态栏;**子窗原生标题 = 子窗自己的活动文件(未保存加 ●)/ 面板名 · 工作区**,随子窗活动
  文件、脏状态、面板标题变化。dockview 开窗时只抄一次主窗当时的标题,此前子窗标题停在主窗某一时刻的文件,重启后主 / 子窗
  标题对调
- 面板进出 popout 时重算(dockview 此时不保证发活动面板 / 活动组事件):重启恢复的 popout 组在 fromJSON 时已是活动组、
  子窗 load 后才挂上 → 恢复落定(`onPopoutRestoreSettled`)时重算,主窗标题取主窗的活动编辑器;弹出 / 收回 / 移动面板
  的组结构事件先于 location 变化派发 → 延到 microtask 重算

## 端到端

- `tests/e2e/title-bar-active-panel.spec.ts`:打开 README.md → 切到终端 tab → 标题栏 / 窗口标题显示终端名、状态栏无文件名;
  切回编辑器 → 恢复
- `tests/e2e/window-state-restart.spec.ts`:设置面板弹出到 popout 后重启 → 主窗标题栏 / 窗口标题 / 状态栏为主窗活动编辑器
- `tests/e2e/popout-window-scope.spec.ts`:编辑器组弹出后切到子窗 → 主窗标题 / 状态栏不变、子窗原生标题是子窗的文件;带着
  弹出的编辑器组重启 → 活动组仍是主窗组、两窗原生标题各是自己的文件、焦点在主窗编辑器
