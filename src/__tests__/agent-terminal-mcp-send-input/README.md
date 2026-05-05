# agent-terminal-mcp-send-input (Agent Terminal MCP Phase 3)

行为契约:**`terminal.send_input` MCP tool**:agent 写 raw 字节给已存在 PTY。
不弹授权窗(决策:agent 持 session_id 即视为已授权,与 list_sessions 同型;
要拒绝 agent 控制 → revoke,持旧 token 立刻 401)。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §5.2

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/mcp-terminal-schemas.ts` | sendInputInput / sendInputOutput zod |
| `electron/main/services/mcp-tools-terminal.ts` | `makeSendInputTool` 工厂 |

## 输入 / 输出

```ts
input: {
  session_id: string,    // PTY id
  data: string,          // 写入字节,可含 \n / \x03(Ctrl+C)/ \x04(Ctrl+D) 等控制字符
}
output: {}               // 无 payload(成功即 ok)
```

`data` 长度上限 2_000_000 字符(沿用 IPC writeInputSchema)。

## 关键行为

### Schema

- `sendInputInputSchema`:
  - `{session_id, data}` 全填 → ok
  - 缺 session_id / data 空字符串 → fail
  - 数据超 2M 字符 → fail
  - 未知字段 → fail(strict)
- `sendInputOutputSchema`:
  - `{}` → ok
  - 含字段 → fail(strict)

### `makeSendInputTool(deps)` 行为

deps:
```ts
{
  has: (sessionId: string) => boolean;
  write: (sessionId: string, data: string) => boolean;
}
```

- `tool.name === 'terminal.send_input'`
- `tool.inputSchema === sendInputInputSchema`
- `tool.run({session_id, data})`:
  1. `has(session_id) === false` → 抛 `TERMINAL_SESSION_NOT_FOUND`
  2. 调 `write(session_id, data)`,成功 → 返回 `{}`
  3. write 返回 false(罕见,PTY 刚死)→ 抛 `TERMINAL_SESSION_NOT_FOUND`
- 不调 ensureAuthorized(send_input 不弹窗,与 list_sessions 同型)
- 字段不变换,直接透传 session_id / data 给 deps

## 不在本主题验证

- 真 PTY write 行为(留 E2E)
- 反向 IPC 串联到 stub — 留 E2E
- 控制字符(Ctrl+C 等)的 PTY 端反应 — 由 termService 单测覆盖
