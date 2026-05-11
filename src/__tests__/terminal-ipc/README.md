# terminal-ipc (M-Terminal Step T2)

行为契约:**terminal.* IPC 通道契约层**:schemas / 通道常量 / handler 接线。
handler 真行为(node-pty spawn / write / resize)需 PTY 运行时,留 E2E 验证;
本主题只测**契约层**:schema 接受 / 拒绝什么、handler 校验 has(id) 与 shell 白名单逻辑。

## 边界(避免重复测试)

| 已被覆盖的不再测 | 在哪 |
|---|---|
| safeHandle 通用语义(senderFrame / IpcResult / code 透传) | `ipc-safe-handle` |
| safeTruncate / isInPlaceUpdate 节流纯函数 | `terminal-service` |

## 通道清单

| Channel | schema | data |
|---|---|---|
| `terminal:create` | `{ shell?, args?, cwd?, env? }` | `{ id }` |
| `terminal:write` | `{ id, data: string ≤ 2M chars }` | `void` |
| `terminal:resize` | `{ id, cols 1-1000, rows 1-500 }` | `void` |
| `terminal:interrupt` | `{ id }` | `void` |
| `terminal:kill` | `{ id }` | `void` |
| `terminal:destroy` | `{ id }` | `void`(alias kill) |
| `terminal:data` | event push | `(id, data)` |
| `terminal:exit` | event push | `(id, { exitCode, signal })` |
| `terminal:overflow` / `recovered` | event push | `(id)` |

## 关键行为

- TERMINAL_CHANNELS 常量字符串与契约一致,值唯一,前缀 `terminal:`
- schemas .strict() 拒未知字段
- write data 超 2M chars → schema fail
- resize cols/rows 出范围 → schema fail
- isAllowedShell 白名单(沿用 Mind):`/bin/{zsh,bash,sh,fish}` + `/usr/{bin,local/bin}` + `/opt/homebrew/bin/` + Win 三件套
- getDefaultShell:Win 默认 powershell.exe;Unix 优先 `$SHELL`,降级 `/bin/zsh`
- makeCreateHandler:
  - shell 不在白名单 → 抛 `TERMINAL_FORBIDDEN_SHELL`
  - cwd 缺失 → 用 homedir
  - 注入的 service.createTerminal 被调一次,id 由 generateId 决定
  - **sessionStore.add 入参附 `ownerWindowId: win.id`**(Issue #28 Phase 1)
- makeListSessionsHandler:
  - 签名 `(input: { ownerWindowId: number })`,**不**接受 renderer 自报字段
  - 调 `sessionStore.getAll({ ownerWindowId })` 过滤
  - registerTerminalIpc 注册时走 `ipcMain.handle` 包装,从 `event.sender → BrowserWindow.id` 推断 ownerWindowId 后传入
- makeWindowClosedCleanup(Issue #28 Phase 1):
  - 工厂返回 `(ownerWindowId) => void`
  - 调 `sessionStore.removeByOwner(ownerWindowId)` 摘 metadata
  - 对返回的每个 id,若 `service.has(id)` 则 `service.kill(id)`

## 不在本主题验证

- node-pty spawn 真行为(留 E2E)
- 多 session 并发(留 T3 store + T5 集成)
- writeHandler / resizeHandler 真调 service(信任注入,不深测)
- 跨 window 隔离的端到端 invariant(在 `terminal-window-isolation` 主题)
