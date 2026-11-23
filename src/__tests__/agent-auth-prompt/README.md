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

- 渲染 Modal,文案带 method label
- 三个按钮:拒绝 / 仅本次 / 本次启动期间允许

### 按钮行为

- 拒绝 → store.deny()
- 仅本次 → store.grant('once')
- 本次启动期间允许 → store.grant('session');respond ok 后才 `confirmSessionGrant`(域授权生效)
- respond 失败(ok:false 或 reject)→ notify.error,且**不**改变未来授权状态
- main 已结算某请求(超时 / 取消)→ 推 `agent-auth:cancelled`,弹窗撤掉、不 respond(畸形通知忽略)。
- respond 返回 `AGENT_AUTH_REQUEST_NOT_PENDING`(main 已超时/撤销结算、取消通知尚在路上时用户点了应答)= 请求已失效 → 只 console.warn,**不**弹 toast,同样**不**改变未来授权状态

### method 标签

- terminal.create_session → 「新建一个 terminal」
- 其它 → 「调用 ${method}」

### 订阅 onRequest

- 挂载时注册 coApi.agentAuth.onRequest
- 收到 payload → ensure → respond
- ensure 结果为 `'cancelled'`(main 已撤销并结算该请求,本地只是取消弹窗)→ **不** respond、不弹失败 toast
  (否则 main 返回 `AGENT_AUTH_REQUEST_NOT_PENDING` → 误导性「授权响应失败」)
- 卸载时 unsub

### 订阅 onRevoked(跨窗口撤销)

- 挂载时注册 coApi.agentAuth.onRevoked;任一窗口撤销成功后 main 广播 `agent-auth:revoked`
- 收到 → `store.applyMainRevoked()`:清全部域(窗口级终端 / debug / 插件工具 + 外部客户端终端 / debug)的 session 授权、epoch+1、取消残留弹窗(不 respond)
- 卸载时 unsub
