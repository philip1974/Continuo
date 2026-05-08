# AgentAuthPrompt(Agent MCP 授权弹窗)

行为契约:**`<AgentAuthPrompt />` 订阅 main 推的 'agent-auth:request' →
调 store.ensure → 弹出 Modal 让用户决策(拒绝 / 仅本次 / 本次启动期间允许)→
调 coApi.agentAuth.respond 回执。pending=null 不渲染。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/AgentAuthPrompt.tsx` | UI |
| `src/stores/agent-auth.store.ts` | 决策 store(已测) |

## 关键行为

### pending=null

- 不渲染

### pending 非空

- 渲染 Modal,文案带 method label / agentLabel
- 三个按钮:拒绝 / 仅本次 / 本次启动期间允许

### 按钮行为

- 拒绝 → store.deny()
- 仅本次 → store.grant('once')
- 本次启动期间允许 → store.grant('session')

### method 标签

- terminal.create_session → 「新建一个 terminal」
- 其它 → 「调用 ${method}」

### 订阅 onRequest

- 挂载时注册 coApi.agentAuth.onRequest
- 收到 payload → ensure → respond
- 卸载时 unsub
