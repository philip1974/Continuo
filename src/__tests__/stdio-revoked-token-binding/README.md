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

### 在途调用(吊销发生在一次工具调用执行期间)

此前复查只发生在请求出队时。stdio 的调用方身份是连接(`stdio:<uuid>`),按 token 回收够不着它;`ctx.signal` 只在
socket 关闭时取消。实测:hello → `create_session{autorun}` 卡在授权弹窗(或 PTY 创建中)→ 持有该 token 的终端
退出 → 用户点允许 → stdio 返回新会话并执行 autorun;HTTP 同序列得
`AGENT_NOT_AUTHORIZED: caller disconnected or revoked before session creation`。`await_stop_hook`(最长 600s)、
`read_output` 等在途时吊销,结果仍写回已失效的连接。

- 三个吊销入口(`revokeToken` / `revokeWindowTokens` / `rotateToken`)之后,mcp-host 经 `onTokensRevoked` 通知;
  stdio server 立即复查所有已绑定连接,绑定所用 token 已失效的:
  - 该绑定下在途调用的 `ctx.signal` 被取消(每个绑定一个 AbortController,并入连接的取消信号)——
    `create_session` 在授权后 / 建 PTY 前 / 建完后的复查点据此不建会话、回收刚建的会话、不跑 autorun;
    `await_stop_hook` 的等待被撤销;
  - 连接的调用方身份作废:以旧身份回调 `onCallerRevoked`(main 取消其在途终端创建、回收其 debug 会话,同 HTTP 侧
    token 吊销);之后的调用拿新身份。已创建的终端会话不被杀(同 HTTP),但重新 hello 后的新身份无权读控它们。
- **响应写回前**再复查一次绑定:已失效 → 丢弃工具结果(终端输出 / transcript / 新会话 id),改回 `NO_WINDOW_CTX`。
- 只影响绑定了被吊销 token 的连接;别的 token 的连接、未 hello 的外部客户端的在途调用照常完成。

### 重新 hello 换绑(hello 改变绑定 = 换调用方身份)

此前 hello 直接覆盖连接的绑定,旧绑定不取消、连接身份(`stdio:<uuid>`)原样保留。实测:hello(tokA) → `create_session`
得 S → hello(无效 token)(或趁 tokA 有效时 hello(tokB))→ tokA 被吊销(旧绑定已不在表里,吊销复查够不着,
`onCallerRevoked` 0 次)→ hello(新 token)→ `send_text(S)` / `read_output(S)` 成功;不换绑的基线是 `not owned by caller`。

- hello 的 (token, windowId) 与连接当前的有效绑定**相同** → 幂等:绑定与身份不变。
- 其余 hello(换 token / 换窗口 / hello 失败 / 从未 hello 的 external 连接改为绑定窗口)一律先按「绑定失效」处理旧
  身份:取消旧绑定下的在途调用、以旧身份回调 `onCallerRevoked`、之后的调用拿新身份。旧身份建的终端会话不被杀,
  但新身份无权读控。
- external → 绑定窗口也换身份:external 与窗口是两个互不放行的授权域(见 `agent-terminal-mcp-auth`),以 external
  授权建的会话不由窗口授权域接管。终端里的 proxy 连上后第一行就是 hello,不受影响。

## 残余

- 不理会 `ctx.signal` 的工具在吊销后仍会跑完当前这一步(例如已写进 PTY 的 `send_text`),只是结果不再写回。
- `tools/list` / `initialize` 不需要窗口上下文,吊销后仍可用(不含会话数据)。

## 规范

- `stdio-revoked-token-binding.spec.ts`:真实 `createMcpHost`(token 表)+ 真实 `createStdioSocketServer` + unix socket。
- `inflight-revocation.spec.ts`:再加真实回收接线(`createMcpRevokerWiring`)与真实终端工具:授权挂起中 / PTY 创建中
  吊销 → 无新会话、无 autorun、返回错误(并与 HTTP 同序列对照);`await_stop_hook` 在途吊销不返回 transcript;
  三个吊销入口都即时取消在途调用;吊销后重新 hello 是新身份;别的连接与外部客户端不受影响。
  「重新 hello 换绑 = 换身份」一组:吊销前换绑(无效 token / 另一个有效 token)后不能保留旧身份;同 token 重复 hello 幂等;
  external → 绑定窗口换身份。
