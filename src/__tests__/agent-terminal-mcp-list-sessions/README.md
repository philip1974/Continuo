# agent-terminal-mcp-list-sessions (Agent Terminal MCP Phase 1)

行为契约:**`terminal.list_sessions` MCP tool 的契约层**:输入 schema(空对象、strict)、
输出 schema(session 字段 + 命名约定)、handler 行为(读 store 快照 + 字段映射)。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §5.4

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/mcp-terminal-schemas.ts` | tool 输入 / 输出 zod schema(main 校验 + spec 共享) |
| `electron/main/services/mcp-tools-terminal.ts` | tool handler 实装(注入 deps) |

需 export(供本主题断言):

| 名字 | 来源 | 描述 |
|---|---|---|
| `MCP_TOOL_LIST_SESSIONS` | `mcp-terminal-schemas` | 字符串常量 `'terminal.list_sessions'` |
| `listSessionsInputSchema` | `mcp-terminal-schemas` | `z.object({}).strict()` |
| `listSessionsOutputSchema` | `mcp-terminal-schemas` | 见下 |
| `makeListSessionsTool(deps)` | `mcp-tools-terminal` | 工厂,返回 `{ name, run }` |

## 输入

```ts
{ } // 空对象,严格(任何额外字段拒)
```

## 输出形态

```ts
{
  sessions: Array<{
    session_id: string,
    title: string,
    cwd: string,
    origin: 'user' | 'agent',
    agent_label?: string,        // 仅 origin === 'agent' 时可能存在
    created_at: number,          // ms epoch
    exit_code: number | null,    // null = 仍运行;number = 已退出
  }>
}
```

**字段命名约定**(本 MCP 暴露面):
- 对外 snake_case(`session_id` / `created_at` / `exit_code` / `agent_label`)
- 对内 store 字段是 camelCase(`id` / `createdAt` / `exitCode` / `agentLabel` / `originHint`)
- 映射在 handler 里完成,**不**让 store 直接暴露给 agent

## 关键行为

### Schema

- `listSessionsInputSchema`:
  - `{}` → ok
  - `{ extra: 1 }` → fail(strict)
  - 非 object → fail
- `listSessionsOutputSchema`:
  - 全字段齐 + 类型对 → ok
  - `agent_label` 缺省允许(optional)
  - `exit_code` 必须显式给(`null` 或 number)

### handler 行为

`makeListSessionsTool({ getSessions })` 返回 `{ name: 'terminal.list_sessions', run }`。

- `run({})` → `{ sessions: [...] }`
- 调 `getSessions()` 一次,把结果按字段映射为输出结构
- 字段映射:
  - `id` → `session_id`
  - `title` → `title`
  - `cwd` → `cwd`
  - `originHint` → `origin`
  - `agentLabel` → `agent_label`(缺省时整字段从输出中省略,不为 `undefined`)
  - `createdAt` → `created_at`
  - `exitCode` → `exit_code`
- 顺序保留(按 store 返回顺序映射)
- 空 sessions → `{ sessions: [] }`

### 不在本主题验证

- store 字段扩展(originHint / agentLabel / cwd)的内部行为 — 在 `terminal-store` topic 加测
- HTTP / SSE / RPC 编解码 — 在 `agent-terminal-mcp-host` topic
- 授权检查 — 留 P2 `agent-terminal-mcp-auth` topic
- 多 tool dispatcher 路由 — 留实装侧或后续 topic

## 假设依赖

`getSessions` 注入函数返回的 session 形态(P1 store 扩展后):

```ts
interface TerminalSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originHint: 'user' | 'agent';
  readonly agentLabel?: string;
  readonly createdAt: number;
  readonly exitCode: number | null;
}
```

本 spec 用 fixture 数组桩,不引 zustand store。
