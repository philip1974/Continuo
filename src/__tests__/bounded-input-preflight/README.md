# bounded-input-preflight(E255/E256/E257 schema-阶段放大族)

## 行为契约

不可信外部数据交给 zod `.strict()` `safeParse` 前,须先做廉价 bounded 预检。`.strict()` 对
unrecognized_keys 是 O(keys) 枚举 + 逐 key 构造 issue/message,错误串 cap 在 parse **之后**才生效,
挡不住 parse 内部 CPU/内存放大。畸形 payload 在 1MiB 级 structured-clone 后塞海量未知短 key,
单请求即可让主进程在 schema 阶段放大。

`electron/shared/bounded-input.ts` 的 `boundedObjectAdmissible(unknown)` 是三处入口共享的单一逻辑来源:

- **E255** MCP `tools/call` arguments(`mcp-host.service.ts` 的 `checkToolArgsBounded`)
- **E256** 通用 IPC 包装 `processIpcCall` / `processIpcCallWithCtx`(`safe-handle.ts` 的 `ipcInputBounded`)
- **E257** plugin-mcp `invoke-reply` raw `ipcMain.on`(`plugin-mcp.ipc.ts`,绕过 safeHandle 预检)

### 规则

1. 仅对 plain object 检自有 key 数量(≤ `MAX_BOUNDED_OBJECT_KEYS`)与单 key 长度(≤ `MAX_BOUNDED_OBJECT_KEY_LEN`)。
2. 非 plain object(string / number / array / null / undefined,均为合法 schema 输入)直接放行,交给 schema 自身校验。
3. 失败返回结构化 `reason`('too-many-keys' / 'key-too-long'),由各调用点映射成自己的领域错误文案(保持各入口既有契约)。
4. plugin-mcp reply 超限时**不进 Zod 但仍交 handleReply**(O(1) 读 requestId),让对应 pending invoke 被 INVALID_REPLY 立即 reject,而非干等满 30s timeout。
