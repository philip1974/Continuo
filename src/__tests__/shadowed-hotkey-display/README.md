# shadowed-hotkey-display(冲突落败的快捷键不在界面提示里显示)

行为契约:**两条命令生效键位相同(同一签名:修饰键 + 主键别名归一)时,分发表里先出现的那条胜出、按下只执行它
(`buildCompiledBindings` 顺序:用户 override 层先于默认层,同层按注册顺序;设置页对落败行标「冲突」,
`selectShadowedBindings`)。落败命令的键位在界面提示里一律不显示 —— 显示了按下也不会执行这条命令。**

与保留键(⌘P / ⌘⇧P)上的绑定同一口径(见 `reserved-command-hotkeys`:未生效的绑定不显示)。VSCode 的命令面板按
`lookupPrimaryKeybinding` 显示键位、不看冲突,但其键位冲突多由 `when` 上下文区分、各自仍可生效;本项目无 `when`,
落败键按下绝不执行该命令,显示它只会误导,故不显示(设置页仍显示键位并标「冲突」,供用户改键)。

## 行为

- **命令面板**行尾:落败命令不显示键位;胜出命令照常显示。例:插件命令默认 `mod+b` 与核心「切换资源管理器侧栏」
  `mod+b` 冲突(核心先注册、同为默认层)→ 插件命令行不显示 ⌘B,侧栏命令显示 ⌘B。
- **tooltip / 菜单项键位**(`src/lib/hotkey-label.ts`:活动栏、编辑器 tab 右键菜单、组「更多操作」菜单):同样不显示落败
  键位。例:用户把插件命令改绑到 `mod+b`(用户层胜出)→ 活动栏「隐藏 / 显示资源管理器」tooltip 不再带 (⌘B)。
- **提示文案里的保存键**(`saveHotkeyLabel`,「按 {hotkey} 选择覆盖」等)、**欢迎页「打开文件夹」键位**:落败 → 退回命令
  标题 / 不显示。
- 冲突解除(改键 / 插件命令注销)后恢复显示;面板与活动栏订阅命令注册表与快捷键 override,随之重算。

## Modules

| File | Role |
|---|---|
| `src/plugins/command-palette/useCommandHotkeys.ts` | `selectShadowedBindings`(与分发同表)、`isHotkeyShadowed`(按命令快照 / 平台 / overrides 缓存) |
| `src/plugins/command-palette/CommandPalette.tsx` | `buildDisplayCommands`:落败命令 `hotkeyParts` 为空 |
| `src/lib/hotkey-label.ts` | `commandHotkeyText` / `useCommandHotkeyText` / `useRegisteredCommandHotkeyText`:落败 → undefined |
| `src/panels/Editor/editor-commands.ts` | `saveHotkeyLabel` |
| `src/panels/Editor/EditorWelcome.tsx` | 欢迎页动作键位 |

## Specs

- `shadowed-hotkey-display.spec.tsx`
