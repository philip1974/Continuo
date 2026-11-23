# agent-terminal-mcp-read-output (Agent Terminal MCP Phase 3)

行为契约:**`terminal.read_output` MCP tool**:agent 增量读 SessionManager buffer。
内部调 `terminal.service.readOutput`(SessionManager wrapper, async);工具、wrapper、SessionManager 三层用同一份 snake_case 协议类型,不做命名转换。

> 配套:`doc/17-agent-terminal-mcp.md`(维护者本地文档,未公开) §5.3
> Buffer 内部行为 / ANSI strip → ContinuoTerminal `__tests__/session-buffer` + `__tests__/get-buffer-snapshot` 和本仓库 `migration-step2-buffer-merge`。
> 本主题只测 tool 契约 + 入参出参原样传递 + error 转换。

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
{ read: async ({ session_id, since_seq?, max_lines?, strip_ansi? }) => { data, lines, next_seq, truncated } }
```

- `tool.name === 'terminal.read_output'`
- `tool.inputSchema === readOutputInputSchema`
- `tool.run(input)`:
  1. 调 `deps.read(input)`,入参原样传递
  2. 缺省字段不补默认值(由 SessionManager 用自己的默认)
  3. 成功 → 结果原样返回 `{data, lines, next_seq, truncated}`
  4. read 抛 TERMINAL_SESSION_NOT_FOUND → 透传(wrapper 已保留原 SESSION_NOT_FOUND cause)
  5. read 抛其它 → 透传
- 不调 ensureAuthorized(read_output 不弹窗,与 list_sessions/send_input 同型)

## 不在本主题验证

- buffer 内部存储 / ANSI strip / 行切分 — 在 ContinuoTerminal `session-buffer` / `get-buffer-snapshot` 与 `migration-step2-buffer-merge`
- PTY onData 写 buffer 链路 — 留 E2E
