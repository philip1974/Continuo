# agent-terminal-mcp-read-output (Agent Terminal MCP Phase 3)

行为契约:**`terminal.read_output` MCP tool**:agent 增量读 buffer。
内部直接调 `terminal-buffer.service`,转换 camelCase 字段为对外 snake_case。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §5.3
> Buffer 内部行为 / ANSI strip → `agent-terminal-mcp-buffer`(已覆盖)。
> 本主题只测 tool 契约 + 字段映射 + error 转换。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/mcp-terminal-schemas.ts` | readOutputInput / readOutputOutput zod |
| `electron/main/services/mcp-tools-terminal.ts` | `makeReadOutputTool` 工厂 |

## 输入 / 输出

```ts
input: {
  session_id: string,
  since_seq?: number,           // 缺省 0(从 buffer 最早保留的 entry)
  max_lines?: number,           // 默认 200,上限 2000
  strip_ansi?: boolean,         // 默认 true
}
output: {
  lines: string[],
  next_seq: number,             // 客户端下次传作 since_seq 实现增量
  truncated: boolean,
}
```

## 关键行为

### Schema

- `readOutputInputSchema`:
  - 仅 session_id → ok
  - 全字段 → ok
  - max_lines 超 2000 → fail
  - max_lines 0 / 负 → fail
  - since_seq 负 → fail
  - 未知字段 → fail(strict)
- `readOutputOutputSchema`:
  - 全字段齐 → ok
  - lines 不是 string array → fail
  - next_seq 负 / 非整 → fail
  - 未知字段 → fail(strict)

### `makeReadOutputTool(deps)` 行为

deps:
```ts
{ read: (sessionId, { sinceSeq?, maxLines?, stripAnsi? }) => { lines, nextSeq, truncated } }
```

- `tool.name === 'terminal.read_output'`
- `tool.inputSchema === readOutputInputSchema`
- `tool.run(input)`:
  1. 调 `deps.read(input.session_id, opts)`,opts 字段 snake_case → camelCase
     (`since_seq` → `sinceSeq`, `max_lines` → `maxLines`, `strip_ansi` → `stripAnsi`)
  2. 缺省字段不传给 deps(让 buffer service 用自己默认)
  3. 成功 → 转字段返回 `{lines, next_seq, truncated}`(camelCase nextSeq → snake_case)
  4. read 抛 BUFFER_SESSION_NOT_FOUND → 转抛 TERMINAL_SESSION_NOT_FOUND
  5. read 抛其它 → 透传
- 不调 ensureAuthorized(read_output 不弹窗,与 list_sessions/send_input 同型)

## 不在本主题验证

- buffer 内部存储 / ANSI strip / 行切分 — 在 `agent-terminal-mcp-buffer`
- PTY onData 写 buffer 链路 — 留 E2E
