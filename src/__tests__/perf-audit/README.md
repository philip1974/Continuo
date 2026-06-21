# perf-audit(性能优化审计 · 与 codex 协作)

第四个 `/goal` 阶段(接安全 S1-S6 / 可维护性 M1-M24 之后):「分析项目性能优化点,直到找不到新的,与 codex 协作」。同 dev-loop:codex(gpt-5.5 high)每轮报一个性能点 → Claude 亲读核实 → **行为保持**优化 + 基准/回归验证 → 反馈 → 下一轮,直到 `###CODEX-DONE###`。

本目录放各轮性能修复的行为契约 spec(关注外部可观测的性能不变量,如「O(1) 分发、不 fan-out」),实现细节的纯函数单测与之并列。

## P1 — 终端输出窗口级单订阅分发(去 O(N) fan-out)

**位置**:`electron/preload/index.ts` `coApi.terminal.onData` + 新模块 `electron/preload/terminal-data-demux.ts`;消费者 `src/panels/Terminal/useTerminal.ts`。

**问题**:旧 `onData(cb)` 每次调用注册独立 `ipcRenderer.on('terminal:data')` listener,回调内 `if (id !== termId) return` 自行过滤。main 已按 session 路由到 owning window,但窗口内 N 个 terminal panel = N 个 listener;任一高输出 session 的每个 chunk 触发全部 N 个回调,N-1 个只做无效过滤。终端输出是高频热路径(build log / agent CLI / tail -f),开销随终端数线性增长。

**修复**:整窗对 `terminal:data` 只挂一个 listener,按 sessionId 路由到 `Map<id, Set<handler>>`。签名 `onData(cb)` → `onData(id, cb)`(cb 只收已过滤的 `data`)。每 chunk 回调开销 O(N) → O(该 id handler 数)≈ O(1)。

**契约不变量**(`terminal-data-demux.spec.ts`):分发只调 id 匹配的 handler,绝不 fan-out 到别 session;unsubscribe 后不再收到;同 id 多 handler 都收到;分发中 unsubscribe 不影响本轮。
