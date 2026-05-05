# agent-terminal-mcp-press-key (Agent Terminal MCP P4+)

行为契约:**`terminal.press_key` MCP tool**:agent 显式按一个特殊键,
server 内部映射到正确的字节序列。让 LLM 不用记 Enter=\\r,Tab=\\t,
方向键=\\x1b[A 等技术细节 — 直接说 `key:'enter'`。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §5
> 设计动机:LF/CR 等控制字符在 raw mode TUI 表现复杂,LLM 容易错。
> 拆开 send_text + press_key 让 server 替 LLM 处理底层细节。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/mcp-terminal-schemas.ts` | pressKeyInput / pressKeyOutput zod + KEY_BYTES 映射 |
| `electron/main/services/mcp-tools-terminal.ts` | `makePressKeyTool` 工厂 |

## 输入 / 输出

```ts
input: {
  session_id: string,
  key: 'enter' | 'tab' | 'escape' | 'backspace'
     | 'ctrl_c' | 'ctrl_d' | 'ctrl_z'
     | 'up' | 'down' | 'left' | 'right',
}
output: {}
```

## 键 → 字节映射

server 内部维护表(导出 `KEY_BYTES` 给 spec 断言):

| key | bytes |
|---|---|
| `enter` | `\\r`(0x0d, CR) |
| `tab` | `\\t`(0x09) |
| `escape` | `\\x1b`(0x1b) |
| `backspace` | `\\x7f`(DEL,大多 TUI 期望;BS 0x08 部分系统用) |
| `ctrl_c` | `\\x03` |
| `ctrl_d` | `\\x04` |
| `ctrl_z` | `\\x1a` |
| `up` | `\\x1b[A` |
| `down` | `\\x1b[B` |
| `right` | `\\x1b[C` |
| `left` | `\\x1b[D` |

不在表内的 key → schema 阶段 fail(enum strict)。

## 关键行为

### Schema

- `pressKeyInputSchema`:
  - `{session_id, key: 'enter'}` → ok
  - 11 个 key 全 ok
  - `key: 'space'` / `'a'` / 任意非枚举字符串 → fail
  - 缺 session_id / key → fail
  - 未知字段 → fail(strict)
- `pressKeyOutputSchema`:`{}` only

### `makePressKeyTool(deps)` 行为

deps 与 send_text / send_input 同型:
```ts
{
  has: (sessionId: string) => boolean;
  write: (sessionId: string, data: string) => boolean;
}
```

- `tool.name === 'terminal.press_key'`
- `tool.run({session_id, key})`:
  1. `has(session_id) === false` → 抛 `TERMINAL_SESSION_NOT_FOUND`
  2. 查 `KEY_BYTES[key]` 拿字节序列
  3. 调 `write(session_id, bytes)`
  4. write 返回 false → 抛 `TERMINAL_SESSION_NOT_FOUND`
  5. 成功 → 返回 `{}`

### 与 send_input 的关系

press_key 内部其实就是 `write(id, KEY_BYTES[key])`,等价 send_input 的特定字节。
区别在 LLM 心智:`press_key('enter')` 比 `send_input('\\r')` 直观,server 也确保
不会写错(LLM 只能选 enum 里的,不会传错字节)。

## 不在本主题验证

- 真 PTY 接收特殊键后行为 — 留 E2E
- 复合按键(如 ctrl+enter / cmd+a)— 不支持,留后续 phase 视需要扩
