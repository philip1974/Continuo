# popout-picker(popout 子窗里打开选择器 / 主窗面板时,焦点与界面在同一窗口)

背景(第四十一轮审计问题 2):编辑器组移到新窗口(dockview popout 子窗)后,子窗获焦时经菜单(或 mac 上没被 renderer 处理、
落到菜单 accelerator 的按键)执行「转到文件 / 转到行 / 命令面板 / 打开最近」:选择器画在主窗,系统焦点却留在子窗 ——
接着输入的字进了子窗编辑器,在子窗按 Esc 关不掉主窗的选择器。⌘, / ⇧⌘F / 显示输出 / 新终端等在主窗打开的面板同样:面板
内容在主窗拿到 DOM 焦点,系统焦点留在子窗。

对齐 VSCode:
- 选择器(Quick Input)画在触发它的窗口(`QuickInputService` 显示时移到 `layoutService.activeContainer`)
- 辅助窗口里 ⇧⌘F 等打开主窗视图 → 视图在主窗打开并聚焦主窗

## 行为(`popout-picker.spec.tsx`)

### 1. 选择器画在触发它的窗口

- 选择器(Quick Open、转到行 = Quick Open `:`、命令面板、打开最近)打开时记下触发窗口(`getCommandDocument`:热键 / 菜单
  分发时 = 按键 / 菜单所在窗口,命令面板等 = 获焦窗口),popout 子窗 → 经 portal 画进该子窗;主窗触发 → 画在主窗
- 菜单(`fromPopout`)、热键(⌘P / ⇧⌘P 在各窗口监听;⌃G / ⌃R / F1 在子窗分发)、菜单 accelerator 三条路径一致
- 子窗里的选择器:初始焦点在其输入框(子窗文档),Esc 在子窗关闭;选中后的操作作用于该窗口(命令面板执行的命令以获焦
  子窗为命令文档,转到行目标 = 该子窗编辑器组,Quick Open 打开到该子窗的活动组)
- 已在另一窗口开着时再按开关键 → 移到按键所在窗口(不关闭);在同一窗口再按 → 关闭
- 选择器所在子窗关闭 → 选择器关闭(不退回主窗)

### 2. 在主窗打开的面板 / 视图:激活主窗

- 用户入口在主窗打开 / 显示面板(`revealDockPanel` / `addPanelAndFocus`:设置、键盘快捷方式、在文件中查找、显示输出…)、
  用户新建的终端落在主窗、显示资源管理器,且此时某个 popout 子窗获焦 → 经 `window:focus` 请求 main 激活主窗
  (renderer 的 `window.focus()` 无用户激活时不激活窗口)
- 落在子窗(子窗「⋯」菜单新建 / 面板本就在子窗)或主窗本就获焦 → 不请求
- 选择器画在主窗而焦点在子窗(未标明触发窗口的入口)→ 同样激活主窗
- main:`window:focus` 激活发起方所在窗口;发起方不对应窗口 → `NO_WINDOW`

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/picker/picker-slice.ts` | `hostDocument`:打开时取 `pickerOpenDocument()` |
| `src/plugins/picker/picker-window.tsx` | `PickerPortal`:按 `hostDocument` portal;子窗关闭 → 关闭 |
| `src/plugins/picker/use-picker-toggle-hotkey.ts` | ⌘P / ⇧⌘P 在主窗与各 popout 子窗监听 |
| `src/plugins/command-palette/useCommandHotkeys.ts` | `POPOUT_HOTKEY_COMMAND_IDS` 加转到行 / 打开最近 / 显示所有命令 |
| `src/shell/dock/main-window-focus.ts` | `focusMainWindowFromPopout` |
| `electron/main/ipc/window.ipc.ts` | `window:focus` |

## E2E

`tests/e2e/popout-picker.spec.ts`:真实 popout 子窗(关焦点模拟、BrowserWindow.focus 切窗口),经菜单钩子触发转到文件 / 命令面板 /
转到行 / 打开最近 / ⇧⌘F,检查选择器所在窗口、获焦窗口、输入去向、Esc、选中后的作用窗口。
