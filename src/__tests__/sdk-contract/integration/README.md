# SDK Contract Integration Specs

Integration specs call registered main-process service handlers through a
stubbed `IpcMain` harness. They use real temporary directories for filesystem
behavior and fake Electron sender events for IPC identity.

- T1: Path-scoped plugin fs handlers enforce granted scopes. 注册插件身份的 webContents
  关窗(destroyed)或 reload(主框架非同文档导航)时,其名下 token 进入 drain、pending scope
  授权请求立即结算;导航之后新文档重新注册的 token 不受影响。
- T2: PathScopeRegistry state transitions work with IdentityRegistry tokens.
- T3: Plugin DataStore service preserves raw IPC storage semantics. `plugin-data:save-serialized`
  接收 value 的 JSON 文本,落盘 `{"value":...}` 与 `plugin-data:save({ value })` 逐字节一致;非字符串 /
  非法 JSON / 拼接注入 / 超形态上限 → BAD_INPUT,落盘文本超 16MiB → PAYLOAD_TOO_LARGE。
- T4: Renderer `IpcPluginDataStore` preserves plugin-facing null/cache/value
  semantics. write 复用字节预检时算出的序列化串走 `saveSerialized`(不再结构化克隆对象图);
  非 JSON 安全值仍在 renderer 拒绝、不发 IPC;cache 仍提交插件原对象。
- T5: Buffered `shell.exec` service preserves exit, timeout, and truncation
  behavior.
- T6: Streaming shell service emits stdout/stderr/exit events and supports
  timeout/abort.

The shared harness lives in `make-stub-ipc.ts` and captures `handle`/`on`
registrations for direct invocation in specs.
