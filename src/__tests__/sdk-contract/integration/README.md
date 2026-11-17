# SDK Contract Integration Specs

Integration specs call registered main-process service handlers through a
stubbed `IpcMain` harness. They use real temporary directories for filesystem
behavior and fake Electron sender events for IPC identity.

- T1: Path-scoped plugin fs handlers enforce granted scopes. 注册插件身份的 webContents
  关窗(destroyed)或 reload(主框架非同文档导航)时,其名下 token 进入 drain、pending scope
  授权请求立即结算;导航之后新文档重新注册的 token 不受影响。
- T2: PathScopeRegistry state transitions work with IdentityRegistry tokens.
- T3: Plugin DataStore service preserves raw IPC storage semantics.
- T4: Renderer `IpcPluginDataStore` preserves plugin-facing null/cache/value
  semantics.
- T5: Buffered `shell.exec` service preserves exit, timeout, and truncation
  behavior.
- T6: Streaming shell service emits stdout/stderr/exit events and supports
  timeout/abort.

The shared harness lives in `make-stub-ipc.ts` and captures `handle`/`on`
registrations for direct invocation in specs.
