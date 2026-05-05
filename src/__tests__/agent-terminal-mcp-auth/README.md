# agent-terminal-mcp-auth (Agent Terminal MCP Phase 2)

行为契约:**外部 agent(via MCP)创建 / 控制内置 terminal 的授权 store**。
首次 agent 调 `terminal.create_session` 时弹窗,用户决定:
- `once` — 仅本次调用通过
- `session` — 本次启动期间所有 agent 调用免提示
- `denied` — 拒绝

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §6
> 决策(2026-05-05):一次性授权(本次启动有效),不持久化。
> 撤销走状态栏"终止全部 agent terminal"按钮 → revoke()。

## 模块

| 文件 | 职责 |
|---|---|
| `src/stores/agent-auth.store.ts` | sessionGranted 标记 + pending request + ensure / grant / deny / revoke |

## 状态形态

```ts
type AuthDecision = 'once' | 'session' | 'denied';

interface PendingAuthRequest {
  readonly requestId: string;
  readonly method: string;        // 'terminal.create_session' 等
  readonly agentLabel?: string;
}

interface AgentAuthState {
  pending: PendingAuthRequest | null;
  sessionGranted: boolean;

  /** 一站式 API:已授权直接放行,否则弹窗(挂起 Promise). */
  ensure(info: { method: string; agentLabel?: string }): Promise<AuthDecision>;

  /** UI 用户操作. */
  grant(kind: 'once' | 'session'): void;
  deny(): void;

  /** 撤销 session 授权(状态栏"终止全部"触发). */
  revoke(): void;
}
```

## 关键行为

### `ensure(info)` — 主入口

- `sessionGranted === true` → **立即** `resolve('session')`,不设 pending
- `pending !== null` → **立即** `resolve('denied')`(同一时刻一个,与 plugin permission-prompt 同型;并发的第二条直接拒)
- 其它 → 设 `pending = { requestId(uuid), method, agentLabel? }`,返回未 resolve 的 Promise

### `grant('once')`

- pending → null
- 已挂起 Promise resolve `'once'`
- `sessionGranted` 不变

### `grant('session')`

- pending → null
- Promise resolve `'session'`
- `sessionGranted = true`

### `deny()`

- pending → null
- Promise resolve `'denied'`
- `sessionGranted` 不变

### `revoke()`

- `sessionGranted = false`
- pending 不变(若正在弹窗,用户仍可决定)

### 边界

- 无 pending 时调 `grant` / `deny` → no-op,不抛
- `ensure` 在 sessionGranted=true 时**不**设 pending(直接 'session'),所以同时能多个 agent 并发 ensure,都直接通过
- `requestId` 注入 deps(默认 `crypto.randomUUID`),便于 spec 断言

## 不在本主题验证

- IPC 反向通道(main → renderer 弹窗 → renderer → main 应答) — 留 E2E
- AgentAuthPrompt UI Modal 渲染 — 走视觉 / 手验
- token rotate 与 kill all agent terminals — 在 P2 实装侧 + 手验
