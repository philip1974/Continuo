# agent-terminal-mcp-send-text (Agent Terminal MCP P4+)

行为契约:**`terminal.send_text` MCP tool**:agent 写**纯文本**到 PTY,
不附加任何键(Enter / Tab 等)。配合 `terminal.press_key` 显式发按键,
让 LLM 不必关心 LF/CR 的差异。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §5
> 设计动机:`send_input` 的 raw bytes 形态在 raw mode TUI(codex/vim/claude)
> 容易被 LLM 错用 `\n`,实测 codex 不接 LF 当 Enter。拆开 send_text + press_key
> 让 LLM 用语义化 API,server 内部正确处理。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/mcp-terminal-schemas.ts` | sendTextInput / sendTextOutput zod |
| `electron/main/services/mcp-tools-terminal.ts` | `makeSendTextTool` 工厂 |

## 输入 / 输出

```ts
input: {
  session_id: string,
  text: string,            // 纯文本,逐字写入 PTY;不追加任何控制字符
}
output: {}
```

## 关键行为

### Schema

- `sendTextInputSchema`:
  - `{session_id, text}` 全填 → ok
  - text 空字符串 → ok(允许显式写空,虽然无副作用)
  - text 超 2M 字符 → fail(沿用 send_input 限制)
  - 缺 session_id / text → fail
  - 未知字段 → fail(strict)
- `sendTextOutputSchema`:
  - `{}` → ok
  - 含字段 → fail

### `makeSendTextTool(deps)` 行为

deps:
```ts
{
  has: (sessionId: string) => boolean;
  write: (sessionId: string, data: string) => boolean;
}
```
(与 send_input deps 完全相同,可共用同一组实参。)

- `tool.name === 'terminal.send_text'`
- `tool.inputSchema === sendTextInputSchema`
- `tool.run({session_id, text})`:
  1. `has(session_id) === false` → 抛 `TERMINAL_SESSION_NOT_FOUND`
  2. 调 `write(session_id, text)` —— **逐字写入,不变换、不追加**
  3. write 返回 false → 抛 `TERMINAL_SESSION_NOT_FOUND`
  4. 成功 → 返回 `{}`
- 不调 ensureAuthorized(同 send_input)

### 与 send_input 的关系

二者**实装行为完全等价**(都是 raw write),区别在**语义**:
- `send_text(text)` —— "写这段文字,不包含按键"
- `send_input(data)` —— "写这段 raw 字节,可含 \\r \\x03 等"

LLM 看 description:写普通字符 → 用 send_text + press_key('enter');
写复杂控制序列 / 二进制 → 才走 send_input。

## 不在本主题验证

- 真 PTY write 行为 — 留 E2E
- LLM 是否真的"选对工具" — 留 prompt 工程 + 真 Claude Code 联调
