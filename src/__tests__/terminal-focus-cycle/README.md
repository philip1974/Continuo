# 终端获焦时切换终端 / 窗格

对齐 VSCode `workbench.action.terminal.focusNext` / `focusPrevious`(「聚焦下一个 / 上一个终端组」)与
`focusNextPane` / `focusPreviousPane`(「聚焦终端组中的下一个 / 上一个终端」)。此前 ⌘T 新建的第二个终端分屏在右侧,
焦点在终端 1 时按 ⌘⇧] / ⌘⇧[ / ⌘⌥→ / ⌘⌥← 焦点都不动(⌘⌥→ / ⌘⇧] 落到「下一个编辑器」,在后台切编辑器 tab)。

Continuo 的终端是 dockview 面板(1 PTY = 1 面板,无面板内拆分):「终端」= 终端面板,「窗格」= 窗口里正显示终端的
dock 组(分屏)。

1. **命令**(三语标题,类别「终端」,命令面板可见,快捷键页可改键):

   | 命令 | mac | Windows / Linux |
   |---|---|---|
   | `workbench.action.terminal.focusNext` 聚焦下一个终端 | ⌘⇧] | Ctrl+PageDown |
   | `workbench.action.terminal.focusPrevious` 聚焦上一个终端 | ⌘⇧[ | Ctrl+PageUp |
   | `workbench.action.terminal.focusNextPane` 聚焦下一个终端窗格 | ⌥⌘→(附加 ⌥⌘↓) | Alt+→(附加 Alt+↓) |
   | `workbench.action.terminal.focusPreviousPane` 聚焦上一个终端窗格 | ⌥⌘←(附加 ⌥⌘↑) | Alt+←(附加 Alt+↑) |

2. **按键只在终端获焦时生效**(`when: terminalFocus` = 按键落在终端输入区,不含终端搜索条):同键的「下一个 / 上一个编辑器」
   (mac ⌥⌘→ / ⌥⌘← / ⇧⌘] / ⇧⌘[,Windows / Linux Ctrl+PageDown / PageUp)在编辑器等其它地方照常生效,两者不算冲突。
3. **不发给 shell**(VSCode commandsToSkipShell 默认含这四条):终端里胜出即让出,两平台都是。窗格命令只在该窗口有不止一个
   终端窗格时让出(VSCode `when: terminalSplitActive`):没有分屏时 Alt+← / Alt+→ 等照常进 shell。
4. **下一个 / 上一个终端**:在触发窗口的全部终端面板间轮转,首尾相接;顺序稳定 = dock 组的空间顺序(网格从左到右、从上到下,
   浮动组在后)、组内按 tab 顺序 —— 含同组里被遮住的 tab(切到时激活该 tab)。目标在被最大化组之外 → 先退出最大化。
   窗口里不足两个终端 → 不动。
5. **下一个 / 上一个窗格**:在触发窗口里**正显示终端**的 dock 组(组的活动 tab 是终端)间按空间顺序移动,首尾相接;
   活动 tab 是编辑器的组不算窗格,组里被遮住的终端 tab 不切出来。只有一个终端窗格 → 不动。
6. **起点**:焦点所在的终端;焦点不在终端(命令面板执行)→ 该窗口的活动终端,再退到该窗口最近使用的终端。
7. **切换后焦点进入目标终端输入区**(内容尚未挂载时等挂载后获焦)。
8. **只作用于触发窗口**(`getCommandDocument`):popout 子窗里按,只在子窗自己的终端间轮转,不跳到主窗;主窗里按不跳进子窗
  (VSCode 辅助窗口里的终端也只在本窗口内切换)。命令在子窗分发。

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/terminal-focus-cycle.ts` | 终端 / 窗格的顺序与切换 |
| `src/core-plugins/TerminalPlugin.ts` | 命令注册 |
| `src/panels/Terminal/terminal-hotkeys.ts` | 命令常量、终端让出(`SKIP_SHELL_COMMANDS`) |
| `src/lib/editor-text-focus.ts` | `terminalFocus` 上下文条件(终端容器标记 `TERMINAL_ATTR`,由 useTerminal 挂上) |

## 规范

- `terminal-focus-cycle.spec.ts`
- e2e:`e2e/terminal-focus-cycle.spec.ts`
