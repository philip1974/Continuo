# SDK Contract Integration Specs

Integration specs call registered main-process service handlers through a
stubbed `IpcMain` harness. They use real temporary directories for filesystem
behavior and fake Electron sender events for IPC identity.

- T1: Path-scoped plugin fs handlers enforce granted scopes.
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
