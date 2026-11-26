# hotkey-menu-suppression(菜单开着时不执行工作台快捷键;菜单失焦即关)

行为契约(对齐 VSCode 上下文菜单:菜单开着时按键由菜单处理、不在背后操作编辑器;菜单失焦即关闭):

- **按键落在打开的菜单里(事件目标在 `[role="menu"]` 内)时,工作台快捷键一律不执行,也不 `preventDefault`**
  (方向键 / Esc / Enter 交给菜单)。菜单包括 Radix 右键菜单(资源管理器 / tab / 终端,portal 到所在文档 body,
  打开即把焦点移入菜单)与自研 DropdownMenu(Explorer / dock 组头部「⋯」)。判定 `isInsideMenu`(`src/lib/menu-focus.ts`)
  不用 `instanceof`,popout 子窗的菜单同样认。
  - 全局分发(`useCommandHotkeys` 主窗 + popout 子窗):右键菜单开着按 ⌘W 不关背后的编辑器,⌘1 / ⌘\ 不执行。
  - 编辑器面板 `onKeyDown`:tab 右键菜单 portal 出去,但 React 事件沿组件树冒泡到面板 → ⌘S 不保存。
  - Quick Open / 命令面板开关键(⌘P / ⌘⇧P):不打开。
  - 应用菜单 accelerator(⌘O 等,renderer 未 preventDefault 时由 main 经 RUN_MENU_COMMAND 回到 renderer):任一文档
    焦点在菜单里 → 不执行。
- **DropdownMenu 失焦即关**:焦点移到菜单与触发按钮(及调用方给的「内部」元素)之外(含 body / 窗口失焦)→ 关闭;
  菜单容器 `tabIndex=-1`,点菜单内空白不算失焦。
- **DropdownMenu 文档级 Esc**:焦点不在菜单里时按 Esc 也关闭;焦点仍在菜单内 → 关闭并还给触发按钮。

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/menu-focus.ts` | `isInsideMenu(target)` |
| `src/plugins/command-palette/useCommandHotkeys.ts` | 分发 handler 判菜单 |
| `src/panels/Editor/EditorPanel.tsx` | 面板 onKeyDown 判菜单 |
| `src/plugins/picker/use-picker-toggle-hotkey.ts` | ⌘P / ⌘⇧P 判菜单 |
| `src/shell/menu-commands.ts` | 应用菜单命令判各文档焦点 |
| `src/lib/dropdown-menu.tsx` | 失焦关闭 + 文档级 Esc |

e2e:`tests/e2e/hotkey-menu-suppression.spec.ts`(资源管理器右键菜单开着按 ⌘W 不关编辑器;「⋯」菜单开着按 ⌘B 不切侧栏、
焦点留在菜单,Esc 关闭并还焦点;焦点被移走 → 菜单关闭)。
