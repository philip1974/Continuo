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

## 规范文件

- `dap-framing.spec.ts`: DAP `Content-Length` framing 的编码/解码契约。
- `debug-schemas.spec.ts`: `debug.*` MCP schema 的 strict/bounds/defaults 契约。
- `mcp-debug-host.spec.ts`: MCP 授权、capability、错误归一化契约。

DebugService 的真实 adapter 生命周期、wait/continue/teardown 幂等行为由 `electron/main/__tests__/debug-service.spec.ts` 覆盖，避免在 BDD 层重复慢路径。
