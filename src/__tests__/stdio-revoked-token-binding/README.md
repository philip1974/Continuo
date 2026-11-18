# stdio-revoked-token-binding(token 吊销后,已 hello 的 stdio 连接立即失效)

## 背景

Continuo 终端里的 agent 经 stdio proxy 连 `mcp.sock`,先发 `_continuo/hello {windowId, token}` 绑定窗口。此前
hello 只在**绑定时**校验一次 token、之后只记 windowId,每次调用只查窗口是否存活。于是:

- 持有该 token 的终端退出(`revokeToken`)、窗口的 token 被吊销(`revokeWindowTokens`)、或用户「撤销全部」
  (`rotateToken`)之后,HTTP 立即 401,而**同一条已绑定的 stdio 连接仍以原窗口身份继续调用工具**
  (实测 `send_text` / `create_session` 都成功)。
- 「撤销后已运行 agent 持的旧 token 立刻失效」的意图(见 `agent-terminal-mcp-auth` 的撤销语义、
  `agent-auth-service` T11)对 stdio 传输不成立。

## 行为

- stdio 连接在 hello 成功时记下所用 token(只存内存,不进日志)。之后**每个请求**复查该 token 仍解析到同一窗口;
  否则(已吊销 / 已轮换)连接降为「hello 失败」状态:`tools/call` 回 `NO_WINDOW_CTX`(-32002),不执行工具,
  也**不**回落成 external 借主窗执行。
- 三种吊销都覆盖:单个 token(终端退出)、按窗口、全部轮换。
- 连接可用**新签发的有效 token** 重新 hello 恢复;用旧 token 重新 hello 无效。
- 只看本连接绑定所用的 token:同一窗口另一个终端的 token 被吊销不影响本连接。
- `tools/list` 不需要窗口上下文,不受影响。
- 从未发 hello 的外部客户端不持 token,不受吊销 / 轮换影响(仍以 external 回落主窗,走独立的 external 授权)。
- HTTP / SSE 侧行为不变(吊销后 401、SSE 连接被关闭)。

## 残余

吊销时**正在执行中**的那一次工具调用不会被打断(「撤销全部」另有处理:未决授权按拒绝结算、在途创建取消、
agent 终端与 debug 会话被终止);复查发生在下一次请求进入时。

## 规范

`stdio-revoked-token-binding.spec.ts`:真实 `createMcpHost`(token 表)+ 真实 `createStdioSocketServer` + unix socket。
