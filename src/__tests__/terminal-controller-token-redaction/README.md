# terminal-controller-token-redaction

行为契约:**MCP 调用方身份(controllerToken)绝不跨 IPC 到 renderer**。

agent 经 MCP 创建的终端会话在 main 侧记录 `controllerToken = ctx.callerSubject`(HTTP 传输下为终端
bearer token,带 Mcp-Session-Id 时为 token + session id),用于 read/send/kill 的 per-session capability 校验。它是 main 内部字段:
renderer(含共享 realm 里运行的插件)拿到它就能冒充该 agent 调 MCP host。

## 关键行为

- `terminal:list_sessions` 的返回(makeListSessionsHandler)不含 `controllerToken`,其余字段原样保留
- `terminal:sessions_changed` 广播(broadcastSessionsChanged)推给 renderer 的快照不含 `controllerToken`
- main 内部 capability 校验仍能读到 controllerToken(`getController(id)` 不受影响)
