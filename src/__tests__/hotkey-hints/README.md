# 快捷键提示:tooltip 与菜单项键位(对齐 VSCode)

行为契约:**按钮 tooltip 写成「名称 (键位)」,菜单项右侧显示键位;命令键位取当前生效绑定(用户改绑跟随、解绑或落在
⌘P / ⌘⇧P 保留键 → 不显示),按平台格式化(mac ⌘⇧⌥,Windows / Linux Ctrl+Shift+Alt,同 `formatHotkey`)。**

## 行为

- **活动栏**:「隐藏 / 显示资源管理器 (⌘B)」(`explorer.toggleSidebar`)、「设置 (⌘,)」(`settings.toggle`)。只改悬停 tooltip,
  可访问名称仍是纯名称(design `NavRailButton` 的 `tooltip`)。改键后立即跟随(订阅快捷键 override 与命令注册表)。
- **编辑器 tab 右键菜单**:「关闭」右侧 ⌘W(`workbench.action.closeActiveEditor`)、「向右拆分」右侧 ⌘\
  (`workbench.action.splitEditor`);菜单打开时取生效绑定。
- **资源管理器右键菜单**:剪切 ⌘X、复制 ⌘C、粘贴 ⌘V、重命名 F2、移到废纸篓 ⌘⌫(Windows / Linux Del);与树内按键同一来源
  (`tree-keyboard` 的 `TREE_KEY_HOTKEYS` / `trashHotkey`,树内键不经快捷键设置)。多选时「移到废纸篓」先条目数再键位。
- **组「更多操作」菜单**:终端 ⌘T(`terminal.new`)、搜索 ⇧⌘F(`workbench.action.findInFiles`)、设置 ⌘,(`settings.toggle`);
  无对应命令的面板不显示。
- **查找选项**:见 `src/__tests__/find-options-parity/`(选项按钮 / 复选框 tooltip「区分大小写 (⌥⌘C)」)。
- 菜单项键位放 design `MenuItem` 的 `shortcut` 槽:视觉显示、`aria-hidden`,不计入可访问名称(菜单项仍按名称念 / 匹配)。

## Modules

| File | Role |
|---|---|
| `src/lib/hotkey-label.ts` | `withHotkey` / `hotkeyText` / `commandHotkeyText`(生效绑定)/ `useCommandHotkeyText` / `useRegisteredCommandHotkeyText` |
| `src/design/MenuItem.tsx` | `shortcut` 槽 |
| `src/design/NavRailButton.tsx` | `tooltip`(悬停提示与可访问名称分开) |
| `src/shell/IconSidebar.tsx` | 活动栏 tooltip |
| `src/panels/Editor/EditorHeader.tsx` / `src/lib/TabContextMenu.tsx` | tab 右键菜单键位 |
| `src/panels/Explorer/ContextMenu.tsx` / `tree-keyboard.ts` | 资源管理器右键菜单键位 |
| `src/shell/dock/HeaderActions.tsx` | 组「更多操作」菜单键位 |

## Specs

- `hotkey-hints.spec.tsx`
