# mcp-startup-audit(main 侧 MCP / 启动路径审计修复)

独立审计者(codex)对 main 侧 MCP 工具与启动输入路径报告的 5 处缺陷的行为契约。

## 规则

1. **await_stop_hook 与 read_output 同等门控**:`terminal.await_stop_hook` 经
   `makeTerminalMcpTools` 统一注册,先过 S2 窗口级授权(denied → `AGENT_NOT_AUTHORIZED`),
   再过 S3 per-session capability(本窗口会话只允许其创建方 `controllerToken === callerSubject`)。
   同窗口另一个调用方不得消费他人会话的 Stop hook(含 `transcript_path` / `last_assistant_message`)。
   `index.ts` 不再在 `makeTerminalMcpTools` 之外单独注册该工具。
   等待期间会话被撤销(「终止全部 agent terminal」删 metadata)/ 被杀 / controller 变更 /
   PTY 退出(metadata 进入 exited-retained,`exitCode !== null`)→ 返回前复查不通过,
   `AGENT_NOT_AUTHORIZED`,不交出 Stop hook 数据。
2. **调用方断开后不执行副作用**:`gateWithAuth` 进入时 `ctx.signal` 已 abort → 直接
   `AGENT_NOT_AUTHORIZED`,不调用 `ensureAuthorized`(不弹授权窗);在 `ensureAuthorized` 返回后再复查 `ctx.signal`,
   已 abort → `AGENT_NOT_AUTHORIZED`(与 create_session R111 同款错误),内部工具不执行;
   `create_session` 在 `installStopHook` 返回后再复查,已 abort → 不 `createSession`;
   `createSession`(异步 spawn)完成时已 abort → 删 metadata + forceKill PTY,以
   `TERMINAL_CREATE_CANCELLED` 结束(不留孤儿会话)。
3. **stdio 每连接排队有上限**:同一连接排队中(含在途)的非空行数或累计字节超上限 →
   与该文件既有超限处理一致:写 PARSE_ERROR 并断开该连接(fail-closed)。错误必须真正送达:
   以 `end(PARSE_ERROR)` 半关闭(不立即 destroy,避免 RST 丢错误行),兜底超时 destroy;
   客户端收到完整 JSON-RPC 错误行后连接关闭。进入拒绝状态后:因 abort 返回的在途调用**不再写响应**
   (end 后 write 会 `ERR_STREAM_WRITE_AFTER_END` 销毁 socket、截断未 flush 的 PARSE_ERROR);
   已链入队列的后续行直接丢弃,不 dispatch、不进授权门控;`broadcast` 通知同样跳过已 end / destroy 的连接。
4. **启动候选检查预算**:`pickArgvFolders` / `pickWindowsToRestore` 除「命中数」上限外,
   另设「候选检查次数」预算:每次 `isExistingDir`(同步 stat)都计数,无论候选是否存在,
   耗尽即停止。
5. **co:// 旧队列优先**:有就绪窗口时依次尝试各就绪窗口排空 pending;旧队列未能全部交付前
   不投递新 URL(新 URL 入队尾,受队列上限约束),保 FIFO 不乱序。

## 规范文件

| 文件 | 规则 |
|---|---|
| `await-stop-hook-gates.spec.ts` | 1 |
| `abort-after-auth.spec.ts` | 2 |
| `stdio-queue-cap.spec.ts` | 3 |
| `startup-check-budget.spec.ts` | 4 |
| `protocol-fifo-order.spec.ts` | 5 |

## stdio 输出背压(终审 P1)

- 排队上限只计未完成的请求,响应写进 socket 写缓冲即扣减;客户端只发不读时输出会无界堆积。
- 每连接未读输出(`writableLength`)超过 `MAX_STDIO_UNREAD_OUTPUT_BYTES`(16MB)即断开该连接(对端不读,
  错误帧也送不达)。正常客户端边写边读,不受影响。
