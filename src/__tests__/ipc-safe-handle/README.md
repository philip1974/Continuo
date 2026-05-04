# IPC safeHandle 契约 (跨里程碑)

行为契约:**所有 IPC 通道**(layout / popout / fs)必须经 `safeHandle` 包装,
统一返回 `IpcResult<T>` envelope,不允许裸 ipcMain.handle。
对应 ADR-010(全工程通道走 safeHandle + IpcResult)。

## 关键行为

1. **senderFrame 不可信 → IPC_DENIED**:防 popout 子 frame / 被注入 iframe 横向越权。
2. **zod 校验失败 → IPC_BAD_INPUT**:错误 message 带具体原因,便于 renderer 调试。
3. **handler 抛普通 Error → IPC_HANDLER_ERROR**:吞异常包成失败结果,不让 renderer 拿到生 Error 堆栈。
4. **handler 抛带 `code` 字段的错 → 透传 code**:业务错误码(如 `FS_NOT_FOUND`)直达 renderer。
5. **handler 成功 → `{ ok: true, data }`**:同步/异步 handler 都支持。
6. **`defaultIsTrustedFrame` 行为**:
   - `null` 或空 url → false
   - `file://` 协议 → true(prod renderer 加载方式)
   - dev 下与 `ELECTRON_RENDERER_URL` 同 origin → true
   - 跨 origin / URL 不可解析 → false

## 不在本主题验证

- `ipcMain.handle` 实际注册(需要 Electron 运行时,留给 E2E)
- `event.senderFrame` 在跨进程的真实行为(同上)
- 具体业务通道(layout / fs)的 schema 与持久化:在各自 BDD 主题验证
