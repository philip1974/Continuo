# agent-terminal-mcp-create-session (Agent Terminal MCP Phase 2)

行为契约:**`terminal.create_session` MCP tool 的契约层**。
agent 通过此 tool 让 Continuo 创建一个新的可见 terminal tab + spawn 默认 shell,
返回 session_id 给 agent 后续 send_input / read_output 用。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §5.1
> P2 不实装 autorun(留 P3),也不接 IPC(本主题只测 tool 函数层)。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/mcp-terminal-schemas.ts` | input / output zod schema |
| `electron/main/services/mcp-tools-terminal.ts` | `makeCreateSessionTool` 工厂 |

需 export(供本主题断言):

| 名字 | 来源 | 描述 |
|---|---|---|
| `MCP_TOOL_CREATE_SESSION` | schemas | `'terminal.create_session'` |
| `createSessionInputSchema` | schemas | `{cwd?, name?, agentLabel?}` strict |
| `createSessionOutputSchema` | schemas | `{session_id}` strict |
| `makeCreateSessionTool(deps)` | tools | 工厂,返回 `{name, inputSchema, run}` |

## 输入 / 输出

```ts
input: {
  cwd?: string,
  name?: string,
  agentLabel?: string,
}
output: { session_id: string }
```

P2 范围**不**接受 `autorun` — schema strict,带 autorun 直接 fail。
P3 实装 autorun 时再扩 schema。

## 关键行为

### Schema

- `createSessionInputSchema`:
  - `{}` → ok(全 optional)
  - 全字段 → ok
  - `{ autorun: 'codex' }` → fail(P2 strict)
  - `{ extra: 1 }` → fail(strict)
- `createSessionOutputSchema`:
  - `{ session_id: 'term-123' }` → ok
  - 缺 session_id / 空字符串 → fail

### `makeCreateSessionTool(deps)` 行为

deps:
```ts
{
  ensureAuthorized: () => Promise<'once' | 'session' | 'denied'>;
  createSession: (input: { cwd?, name?, agentLabel?, originHint: 'agent' }) => Promise<{ id: string }>;
}
```

- `tool.name === 'terminal.create_session'`
- `tool.inputSchema === createSessionInputSchema`
- `tool.run(input)`:
  1. 调 `ensureAuthorized()`
  2. 返回 `'denied'` → 抛 `AGENT_NOT_AUTHORIZED`(不调 createSession)
  3. 返回 `'once'` 或 `'session'` → 调 `createSession(...)` 透传 cwd / name / agentLabel,**强制 originHint='agent'**
  4. createSession 抛 → 透传(不吞)
  5. createSession 成功 → 返回 `{ session_id: r.id }`
- agentLabel 缺省 → 用 `'agent'`(便于 UI 兜底标记)
- name 缺省 → 不传给 createSession(让 IPC handler 调 nextDefaultTitle)
- cwd 缺省 → 不传(IPC handler 用 homedir)

### 字段透传

input → createSession 调用参数:
| input 字段 | 传给 createSession |
|---|---|
| `cwd` 给值 | `cwd` 透传 |
| `cwd` 缺省 | 不传 |
| `name` 给值 | `name` 透传 |
| `name` 缺省 | 不传 |
| `agentLabel` 给值 | `agentLabel` 透传 |
| `agentLabel` 缺省 | `agentLabel: 'agent'` |
| 永远 | `originHint: 'agent'`(不允许 agent tool 创建 user 类型) |

## 不在本主题验证

- IPC 反向通道(ensureAuthorized 真接 renderer 弹窗) — 留 E2E
- 真 PTY spawn — 在 `terminal-ipc` + E2E
- token rotate / kill all on revoke — 留 P2 实装侧
