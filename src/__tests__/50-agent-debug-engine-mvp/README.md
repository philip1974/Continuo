# 50 · Agent Debug Engine MVP

本主题锁定 agent 通过 Continuo MCP 调试 Node.js 程序的 MVP 契约。

## 行为契约

- `debug.*` MCP tools 使用 `electron/shared/mcp-debug-schemas.ts` 作为输入/输出边界。所有 advertised object schema 必须关闭 `additionalProperties`。
- `debug.launch` 首次调用必须走 agent 授权，授权 method 是 `debug.launch`，并把 MCP caller subject 写入 DebugService 的 `controllerToken`。
- 除 `debug.launch` / `debug.list_sessions` 外，带 `session_id` 的 debug 工具必须同时满足当前窗口归属与 `ctx.callerSubject === controllerToken`，否则拒绝，不触达 DebugService。
- 跨窗口 debug session 对当前调用方表现为 not found，不暴露 capability 细节。
- DebugService 的 plain Error 在 MCP 工具边界归一化为稳定 debug 错误码，避免向 MCP client 回显超长 session id、program 或 adapter path。
- `variables` / `evaluate` 保持分页、深度、字节预算与默认值边界。
- KC#1: MVP 暂不暴露 renderer/editor context 的断点映射能力，降级为 main-context DAP 调试；源码映射与编辑器联动留给后续批次。
- 安全(program-workspace 锁): `debug.launch` 的 `program`/`cwd` 来自 agent，必须落在 owner window 的 workspace root 内(realpath 规范化后比较，防 symlink 逃逸与 `..` 穿越)；窗口无 workspace 记录则 fail-closed 拒绝；`cwd` 省略时默认 workspace root，不回退 main 进程 cwd。该契约由 `electron/main/__tests__/debug-service.spec.ts` 覆盖。

- `debug.disconnect` 始终终止 Continuo launch 的 debuggee(teardown 按 adapter 进程组整组回收);`terminate_debuggee` 只接受 `true` 或省略,`false` 在 schema 层显式拒绝(不再静默忽略),zod 与手写 JSON schema(`const: true`)一致。
- 程序起跑时机: `debug.launch` 完成 DAP initialize 后返回 `state: "starting"`,此时程序尚未运行;`configurationDone` + `launch` 推迟到第一个要求程序运行的调用(`wait_for_stop` / `continue` / `step_*`)且只发一次,`set_breakpoint` 本身不让程序起跑 —— 起跑前设的多个断点都在程序运行之前就位。没设断点直接 `wait_for_stop`(如 `stop_on_entry`)也能起跑;尚无停点时 `continue` 即「让程序跑起来」。
- 断点按 source 维护完整集合(DAP `setBreakpoints` 语义): 同一文件的新断点与已有断点一起发送(同 file+line 去重),不覆盖;child session 建立时按 source 重放全部断点;返回值是本次新设断点的结果。同 session 同 source 的设置串行执行(集合与 `breakpoints-changed` 快照按调用顺序);请求失败 / 超时回滚本地记录后,尽力向父连接与存活 child 补发回滚后的完整集合(短超时、失败忽略,原错误照抛);快照按 adapter 校正后的 file:line 去重(保留首个),adapter 未逐项回报(空 / 短数组)时沿用该断点上次的校正结果。source 按平台归一分组(Windows 大小写不敏感、`/` 与 `\` 等价),发给 adapter 与推给 renderer 的路径用该 source 首次记录的拼写。
- 会话数上限在 spawn adapter 之前检查;spawn 期间被并发 launch 占满名额时释放已 spawn 的 adapter,不残留 runtime。
- DAP 入站帧必须是顶层带字符串 `type` 的 JSON 对象;`null` / 数组 / 标量等按畸形帧处理(结算在途请求并断开连接),不抛成主进程未捕获异常。

## 规范文件

- `dap-framing.spec.ts`: DAP `Content-Length` framing 的编码/解码契约。
- `debug-schemas.spec.ts`: `debug.*` MCP schema 的 strict/bounds/defaults 契约。
- `mcp-debug-host.spec.ts`: MCP 授权、capability、错误归一化契约。

DebugService 的真实 adapter 生命周期、wait/continue/teardown 幂等行为由 `electron/main/__tests__/debug-service.spec.ts` 覆盖，避免在 BDD 层重复慢路径。
