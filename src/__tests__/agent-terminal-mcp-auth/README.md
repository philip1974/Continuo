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
type EnsureOutcome = AuthDecision | 'cancelled'; // 'cancelled':main 已撤销并结算

interface PendingAuthRequest {
  readonly requestId: string;
  readonly method: string;        // 'terminal.create_session' 等
  readonly agentLabel?: string;
}

interface AgentAuthState {
  pending: PendingAuthRequest | null;
  sessionGranted: boolean;        // 终端域
  debugSessionGranted: boolean;   // debug 域
  pluginSessionGranted: boolean;  // 插件工具域
  // 外部客户端(stdio 未发 hello,未绑定 Continuo 终端)的终端 / debug 域授权,与上面窗口级授权互不放行。
  // 无 external 插件域:main plugin-mcp-bridge 在授权前即拒绝外部客户端调插件工具。
  externalSessionGranted: boolean;
  externalDebugSessionGranted: boolean;

  /** 一站式 API:已授权直接放行,否则弹窗(挂起 Promise). */
  ensure(info: { method: string; agentLabel?: string; external?: boolean }): Promise<EnsureOutcome>;

  /** UI 用户操作. */
  grant(kind: 'once' | 'session'): void;
  deny(): void;

  /** 撤销 session 授权(状态栏"终止全部"触发). */
  revoke(): void;
  /** main 已撤销(本窗口 IPC 成功 / 跨窗口广播):revoke + 取消残留弹窗. */
  applyMainRevoked(): void;
}
```

## 关键行为

### `ensure(info)` — 主入口

- 请求所属域已授权 session → **立即** `resolve('session')`,不设 pending。**授权分三个域**:
  method 以 `debug.` 开头的属 debug 域(看 `debugSessionGranted`);以 `plugin.` 开头的属插件工具域
  (看 `pluginSessionGranted`,main 侧 plugin-mcp-bridge 以 `plugin.<tool 名>` 请求,见 `plugin-mcp-multi-window`);
  其余属终端域(看 `sessionGranted`)。对某个域点「本次启动期间允许」不会放行其它域 —— 每个域第一次调用各弹一次
- **按调用方类别再分**:`external: true`(main 侧 stdio 连接未发 `_continuo/hello`,回落主窗)只看 / 只写
  `external*SessionGranted`,不复用也不写入窗口级授权;弹窗标注「外部客户端(未绑定 Continuo 终端)」。
  否则窗口 B 终端里的 agent 绕过 proxy 直连 mcp.sock 不发 hello,即可借主窗 A 的授权静默 create_session / debug_launch
- `external: true` + `plugin.*` → **立即** `resolve('denied')`,不弹窗、不记授权(纵深:main 已先拒)
  - **残余风险(未收口)**:external 隔离只区分「发没发 hello」,不验证调用方是谁。任一同用户进程若读到某窗口终端的
    token(PTY env `CONTINUO_MCP_TOKEN`,如 macOS `ps eww`、Linux `/proc/<pid>/environ`),即可带该 token 经 HTTP
    或 stdio `_continuo/hello` 被当作该窗口的绑定调用,复用该窗口的「本次启动期间允许」静默执行。per-session
    capability 仍生效(只能操作自己创建的会话 / debug 会话)。真正收口需把 token 绑定到持有该终端的进程树,当前未做。
- 同一类调用方(窗口内 agent / external 客户端)已占槽 → **立即** `resolve('denied')`(与 plugin permission-prompt 同型;同类并发的第二条直接拒)。
  另一类调用方已有弹窗显示中 → **排队**(不自动拒、不堆叠),当前弹窗落定后显示;`pending` 始终是显示中的那一个。
  见 `src/__tests__/agent-auth-prompt-throttle/`(external 连弹不得顶掉窗口内 agent 的首次授权)
- 其它 → 设 `pending = { requestId(uuid), method, agentLabel? }`,返回未 resolve 的 Promise

### `grant('once')`

- pending → null
- 已挂起 Promise resolve `'once'`
- `sessionGranted` 不变

### `grant('session')`

- pending → null
- Promise resolve `'session'`
- **不**立即置域标志:该请求在 main 可能已被撤销 / 超时删除(旧弹窗仍显示),立即置 true 会让之后的请求被静默放行

### `confirmSessionGrant(method, epoch, external?)`

- 应答方(AgentAuthPrompt)在 main 确认该 requestId 仍在等待(respond ok)后调
- method 所属域的标志置 true(终端域 `sessionGranted` / debug 域 `debugSessionGranted` / 插件工具域 `pluginSessionGranted`)
- `epoch` ≠ 当前 `getAgentAuthEpoch()`(期间发生过 `revoke()`)→ 忽略,不复活已撤销授权

### `deny()`

- pending → null
- Promise resolve `'denied'`
- `sessionGranted` 不变

### `revoke()`

- 全部域(`SESSION_GRANT_KEYS`)的 session 授权置 false,撤销代际 epoch +1
- pending 不变(store 层;状态栏撤销在 main 确认成功后另行 `applyMainRevoked()` 清掉旧弹窗,见 status-bar)

### `applyMainRevoked()`

- main 已撤销时调:本窗口撤销 IPC 成功(status-bar),或收到其它窗口撤销的 `agent-auth:revoked` 广播(AgentAuthPrompt)
- 与 `revoke()` 同样重置(全部域 session 授权清空 —— 窗口级三域与外部客户端两域,见 `SESSION_GRANT_KEYS`;epoch +1 → 在途的 session 确认迟到不复活)
- 残留 pending → 清空,挂起的 ensure resolve `'cancelled'`(main 已结算该请求,应答方不得再 respond)

### 边界

- 无 pending 时调 `grant` / `deny` → no-op,不抛
- `ensure` 在 sessionGranted=true 时**不**设 pending(直接 'session'),所以同时能多个 agent 并发 ensure,都直接通过
- `requestId` 注入 deps(默认 `crypto.randomUUID`),便于 spec 断言

## 不在本主题验证

- IPC 反向通道(main → renderer 弹窗 → renderer → main 应答) — 留 E2E
- AgentAuthPrompt UI Modal 渲染 — 走视觉 / 手验
- token rotate 与 kill all agent terminals — 在 P2 实装侧 + 手验
