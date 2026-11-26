# workbench-missing-commands

补齐 VSCode 常用但 Continuo 此前缺失的命令 / 默认键(第四十轮审计)。命令一律走命令注册表 → 快捷键设置页(改键 / 解绑 /
冲突)、`isHotkeyShadowed`、`resolveDisplayHotkey`、命令面板自动覆盖。多默认键模型见 `src/__tests__/command-secondary-hotkeys/`。

## §1 附加默认键(`additional-default-keys.spec.ts`)

| 命令 | 主键 | 附加默认键 | 说明 |
|---|---|---|---|
| `workbench.action.nextEditor` / `previousEditor` | mac ⌥⌘→ / ⌥⌘← | mac ⇧⌘] / ⇧⌘[ | Windows / Linux 无附加键(VSCode 同) |
| `terminal.new` | ⌘T / Ctrl+T | ⌃⇧`(各平台) | VSCode `workbench.action.terminal.new`;终端里让出(commandsToSkipShell) |
| `workbench.action.showCommands` | ⇧⌘P(保留键,picker 处理) | F1(各平台) | F1 进命令分发;终端里让出 |

- ⇧⌘[ / ⇧⌘] 按物理键匹配(e.key 为上档字符 `{` / `}` 也认),编辑器面板内同样就地切换(面板裁决同一张表)。
