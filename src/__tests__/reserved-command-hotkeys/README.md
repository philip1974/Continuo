# 保留键命令显示其键位(转到文件… ⌘P / 显示所有命令 ⇧⌘P)

第三十轮审计:「转到文件…」实际是 ⌘P,但快捷键设置页显示「未绑定」(还有编辑按钮),命令面板也不显示 ⌘P。对齐 VSCode
(`workbench.action.quickOpen` 显示 ⌘P、`workbench.action.showCommands` 显示 ⇧⌘P)。

⌘P / ⇧⌘P 是 Quick Open / 命令面板的保留键(`PICKER_TOGGLE_HOTKEYS`,document 级写死监听,见 `use-picker-toggle-hotkey.ts`)。
两条归属命令(`PICKER_TOGGLE_COMMAND_IDS`)**只显示**保留键,不参与命令分发(否则一键两动作)。

## 行为

- **显示**:命令面板列表、界面 tooltip(`commandHotkeyText`)显示「转到文件… ⌘P」「显示所有命令 ⇧⌘P」(Windows / Linux
  Ctrl+P / Ctrl+Shift+P);用户对这两条命令的旧 override 不影响显示。
- **不分发**:两条命令不进全局热键表(`buildCompiledBindings`),即使存有旧 override(如 ⌘K)也不响应 —— 键位只归 picker 监听。
- **快捷键设置页**:两行显示保留键键帽 + 「保留键，不可更改」(三语);编辑按钮禁用且不可见(保持键帽列对齐);按快捷键搜索
  (`ctrl+p`)能找到该行,计入「已绑定」。
- **改键冲突**:别的命令改绑到 ⌘P / ⇧⌘P 仍按既有规则拒绝保存并提示保留键(`keybinding-capture-modal`);两条归属命令的旧
  override 不作为冲突项列出(它们不分发)。
- **显示所有命令**:新增命令 `workbench.action.showCommands`(Show All Commands,三语,无分类),执行 = 打开命令面板(关闭
  Quick Open)。

## Modules

| File | Role |
|---|---|
| `src/plugins/picker/use-picker-toggle-hotkey.ts` | `PICKER_TOGGLE_COMMAND_IDS` / `reservedHotkeyOfCommand` / `resolveDisplayHotkey`;`resolveActiveHotkey` 对归属命令返回 undefined |
| `src/plugins/command-palette/CommandPalette.tsx` | 列表键位用 `resolveDisplayHotkey` |
| `src/lib/hotkey-label.ts` | tooltip 键位用 `resolveDisplayHotkey` |
| `src/plugins/settings/KeybindingsTabContent.tsx` | 归属命令行:保留键键帽 + 「保留键，不可更改」,编辑按钮禁用 |
| `src/plugins/keybindings/KeybindingCaptureModal.tsx` | 冲突列表跳过归属命令 |
| `src/shell/window-commands.ts` | 注册 `workbench.action.showCommands` |

## Specs

- `reserved-command-hotkeys.spec.tsx`
