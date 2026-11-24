# hotkey-modal-suppression(Modal 打开时不执行工作台快捷键)

行为契约(对齐 VSCode:对话框打开期间工作台快捷键不触发,按键只给对话框):**事件所在文档有打开的 Modal 时,
工作台快捷键一律不执行,也不 `preventDefault`(Esc / Tab / Enter 留给 Modal 与其中的控件)**。

- `hasOpenModalIn(doc)`(`src/design/Modal.tsx`):按文档栈判定 —— 主窗与 dockview popout 子窗各看自己的栈;
  第二参数 `besides` 表示「调用方自己的 Modal 不算」(栈深超过它才算有别的 Modal)。
- 全局命令分发(`useCommandHotkeys` 的主窗 + popout 分发):删除确认框 / Agent 授权框 / 保存三按钮框开着时
  ⌘T 不新建终端、⌘W 不关背后的 tab / 面板 / 窗口、⌘S 不保存。Modal 关闭后恢复。
- 编辑器面板 `onKeyDown`:面板内的确认框(渲染在 EditorPanel DOM 内)里按键冒泡到面板 → 不保存、不切换编辑器。
- 终端让出(`isTerminalZoomHotkey` / `isTerminalSearchHotkey` / `terminalYieldedCommandId`):事件所在文档有 Modal →
  不让出、不执行命令。
- 终端挂载聚焦(`useTerminal` focusOnInit):有 Modal 打开时 xterm 晚挂载也不抢焦点。
- Quick Open / 命令面板本身也是 Modal:它们自己的开关键(⌘P / ⌘⇧P)仍工作 —— 再按关闭、按另一个切换(互斥);
  但 picker 之上还叠着别的 Modal(如 Agent 授权框)或只有非 picker 的 Modal 时,⌘P / ⌘⇧P 不打开、不切换。

## 模块

| 文件 | 职责 |
|---|---|
| `src/design/Modal.tsx` | `hasOpenModalIn(doc, besides)` |
| `src/plugins/command-palette/useCommandHotkeys.ts` | 分发 handler 开头判 Modal |
| `src/plugins/picker/use-picker-toggle-hotkey.ts` | picker 开关:只在「只有 picker 自己」时放行 |
| `src/panels/Editor/EditorPanel.tsx` | 面板 onKeyDown 判 Modal |
| `src/panels/Terminal/terminal-hotkeys.ts` / `useTerminal.ts` | 让出判 Modal、focusOnInit 判 Modal |

e2e:`tests/e2e/hotkey-modal-suppression.spec.ts`(删除确认框开着时 ⌘T 不新建终端、焦点仍在框内)。
终端 focusOnInit 的用例在 `dock-terminal-vscode-focus/new-terminal-focus.spec.ts`(复用其 xterm mock)。
