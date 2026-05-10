# Terminal 键位映射(`mapTerminalKey`)

行为契约:**Continuo 内置 terminal 在 xterm 默认按键之上额外拦截若干组合键,
把它们翻译成 PTY 字节序列写回**。当前覆盖:Shift+Enter → 多行输入触发(issue #18)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Terminal/key-mapping.ts` | 纯函数 `mapTerminalKey(event)` |
| `src/panels/Terminal/useTerminal.ts` | xterm `attachCustomKeyEventHandler` 调用方 |

## 关键行为

### Shift+Enter → ESC+CR(`\x1b\r`)

- iTerm2 等终端配合 Claude Code / Codex / 任何 ink-based TTY 应用,Shift+Enter
  应触发输入框内换行而非提交。约定上靠 `\x1b\r`(Alt+Enter / Meta+Enter
  转义前缀)区分:这些 CLI 看到 ESC 前缀即识别为多行输入。
- 普通 shell(bash / zsh / fish)readline 默认把 ESC+CR 当作 `accept-line`
  (等同 Enter),所以走 shell 不会被打断,fallback 干净。
- 仅在 `keydown` 上触发,且不能与 Ctrl / Meta / Alt 同按 — 避免与既有快捷
  键(如 Ctrl+Shift+Enter)冲突。

### 其余按键

- 普通 Enter、单独 Shift、其他键全部返回 `null`,交回 xterm 默认处理(`\r` 等)。
