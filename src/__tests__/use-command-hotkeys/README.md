# useCommandHotkeys(全局命令快捷键监听 hook)

行为契约:**`useCommandHotkeys(commands)` 把 CommandRegistry 中所有 cmd 的有效 hotkey
注册成 document keydown 监听,匹配则 preventDefault + stopPropagation + 调 cmd.fn()。
registry 变更与 keybindings overrides 变更都重排监听;hook 卸载移除监听。
matchesHotkey 已有独立 spec(command-hotkeys 主题),此处补 effect 行为。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/command-palette/useCommandHotkeys.ts` | hook + matchesHotkey |
| `src/plugins/registries/CommandRegistry.ts` | command 注册 |
| `src/plugins/keybindings/keybindings-store.ts` | overrides 持久化 |

## 关键行为

### 命中 hotkey

- 调 cmd.fn()
- preventDefault + stopPropagation
- 匹配第一条即 return,不再检查后续

### 未注册任何 hotkey

- 不抛、不调任何 fn

### registry 增删命令

- subscribe 触发 setSnap → effect 重订阅
- 老命令的 hotkey 不再触发,新命令立即生效

### overrides 变化

- 用户改键 → keybindings-store overrides 变 → effect 重跑

### 卸载

- 移除 document keydown 监听
