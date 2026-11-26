# ⌃` 切换终端

对齐 VSCode `workbench.action.terminal.toggleTerminal`(各平台 ⌃`)。此前 ⌃` 无反应,只能 ⌘T 新建终端。

1. **命令**:`workbench.action.terminal.toggleTerminal`,三语标题「切换终端」,默认键 `ctrl+`` `(mac / Windows / Linux 都是
   Control)。经命令注册表接入快捷键页、命令面板键位显示与冲突判定。
2. **焦点不在终端**(在编辑器、资源管理器、其它面板):触发窗口里**最近使用的终端**激活并获焦(按面板激活顺序,不按 dock
   面板顺序);该窗口一个终端都没有 → 主窗新建一个(与 ⌘T 同一流程,新建后获焦)。
3. **焦点已在终端**:回到触发窗口的活动编辑器(编辑器组面板激活,焦点进编辑区);该窗口没有编辑器组 → 不动。
4. **终端里**:⌃` 让出(不进 shell),两平台都是(VSCode commandsToSkipShell 默认含它)。
5. **作用于触发它的窗口**(`getCommandDocument`):popout 子窗里按,只在子窗的终端 / 编辑器之间切换;子窗没有终端时不新建
   (新终端画在主窗,焦点却留在子窗)。命令在子窗分发。

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/toggle-terminal.ts` | 切换逻辑 |
| `src/shell/dock/group-mru.ts` | 面板 MRU(`mostRecentPanelInDocument`) |
| `src/core-plugins/TerminalPlugin.ts` | 命令注册 |
| `src/panels/Terminal/terminal-hotkeys.ts` | `TERMINAL_TOGGLE_COMMAND`、终端让出 |

## 规范

- `terminal-toggle.spec.ts`
