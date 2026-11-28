# debug-adapter-crash(调试适配器意外退出 → 结束会话并提示)

参考 VSCode:`RawDebugSession`(`src/vs/workbench/contrib/debug/browser/rawDebugSession.ts`)在适配器 `onExit` / `onError`
时 `shutdown` 并发 `onDidExitAdapter`(非 0 退出码带 error);`DebugSession.onDidExitAdapter` 结束会话;`DebugService` 收到带 error 的
`onDidEndAdapter` 时通知「Debug adapter process has terminated unexpectedly ({0})」。

## DapClient(`dap-client-connection-lost.spec.ts`,真实子进程)

- adapter 子进程被杀 → `onServerExit` 回调带退出 code / signal;连接随之断开 → `onConnectionLost` 回调
- 本端 `dispose()` 关掉连接不算意外断开(不回调)

## DebugService(`debug-service-adapter-loss.spec.ts`)

- 会话运行中 adapter 非 0 退出 / 被信号杀掉,或连接意外断开 → 整个会话结束:
  - 在途的 `wait_for_stop` 立即以「debug adapter process has terminated unexpectedly (…)」失败,之后再调用同样立即失败
  - MCP `list_sessions` 里该会话 state = `terminated`(不再是 running)
  - 向 owner 窗口推 `terminated`,带 `adapterCrashed`(说明,如 `signal: SIGKILL`)
- adapter 以 0 退出 → 会话同样结束,但 `terminated` 不带 `adapterCrashed`(VSCode:正常退出不提示)
- 只结算一次:连接断开与进程退出先后到达,只推一次 `terminated`
- 会话已结束(terminated 事件之后)或正在拆除(disconnect / 关窗 / 退出时本端杀 adapter)→ 不当作意外退出
- adapter 没了但 debuggee 未必结束:其 pid 记录保留给 teardown 回收

## 渲染端(`debug-store-adapter-crash.spec.ts`)

- 收到带 `adapterCrashed` 的 `terminated` → 错误通知「调试适配器进程意外终止(<说明>)」(三语),会话从调试视图移除
- 普通 `terminated` 不提示
