# command-secondary-hotkeys

一个命令可以有**多个默认键**(对齐 VSCode:`IKeybindings` 的 `primary` + `secondary[]`,一个命令多条 keybinding;如
mac 上「打开下一个编辑器」既是 ⌥⌘→ 也是 ⇧⌘])。

## 数据模型

- `CommandSpec.hotkey`:主默认键(界面显示的那条)。
- `CommandSpec.secondaryHotkeys?: readonly string[]`:附加默认键(≤ 8 条,形态与 `hotkey` 同一校验)。`hotkey` 缺省时
  `secondaryHotkeys[0]` 充当主键。
- 用户覆盖(`continuo.keybindings.overrides`,`Record<commandId, string>`)格式不变:改键 = 新组合**覆盖全部默认键**,
  解绑(`''`)= 全部默认键都不生效,恢复默认 = 删 override(主键 + 附加默认键一起回来)。旧数据原样可读。
- 保留键归属命令(显示所有命令 ⇧⌘P / 转到文件 ⌘P)的保留键仍由 picker 监听处理;其附加默认键(显示所有命令的 F1)
  照常进命令分发(不可改,行上标「保留键,不可更改」)。

## 行为

- 分发(`buildCompiledBindings` / `winningCommandFor`):每个生效键各占一条,任一键都执行该命令;编辑器面板 / 终端的
  就地处理同一张表裁决,故附加默认键在面板内同样生效。
- 冲突(`selectShadowedBindings`):命令任一键落败即标「冲突」;`isHotkeyShadowed` 只看主键(显示的那条)—— 附加默认键
  被别的命令占了,主键仍照常显示。
- 显示(命令面板行尾、tooltip、菜单、`resolveDisplayHotkey`):只显示主键。快捷键设置页显示全部生效键(主键在前,` / `
  分隔),按快捷键搜索时任一键命中即列出;重置按钮提示列出全部默认键。
- 录键弹窗的冲突提示:别的命令任一生效键与录到的键相同即列为冲突(含显示所有命令的 F1)。
- 注册表的默认键冲突告警(`CommandRegistry`)同样计入附加默认键。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/registries/CommandRegistry.ts` | `secondaryHotkeys` 字段与校验、`defaultHotkeysOf` |
| `src/plugins/keybindings/keybindings-store.ts` | `resolveEffectiveHotkeys`(override 覆盖全部默认键) |
| `src/plugins/picker/use-picker-toggle-hotkey.ts` | `resolveActiveHotkeys`(去掉保留键;保留键命令只剩附加默认键) |
| `src/plugins/command-palette/useCommandHotkeys.ts` | 分发表、冲突(任一键 / 主键) |
| `src/plugins/settings/KeybindingsTabContent.tsx` | 全部键显示与搜索 |
| `src/plugins/keybindings/KeybindingCaptureModal.tsx` | 冲突检测 |
