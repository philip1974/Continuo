# terminal-window-isolation (Issue #28 Phase 1)

行为契约:**terminal sessions 按 BrowserWindow 隔离**。同时打开多个 window 操作不同项目时,
每个 window 只看到自己创建的 terminal sessions;一个 window 关闭时,其名下所有 PTY 直接 kill。

> 配套 issue:[#28](https://github.com/philip1974/Continuo/issues/28)
>
> 决策(2026-05-11):
> - **隔离单位 = `BrowserWindow.id`**(进程内运行时 ID)。terminal sessions 不持久化,
>   无需跨重启稳定 ID,因此**不**走 windowSeq;改动最小、IPC 端 `event.sender → win.id` 直取。
> - **window 关闭 = 直接 kill 该 owner 的所有 PTY + 摘 metadata**。不保留、不挂起、不迁移。
> - **MCP agent session 归属拆到 [#29 Phase 2]**:本主题不验 `createSessionForAgent`
>   的归属逻辑,仅断言"若 owner 字段被设置成 X,后续过滤/路由按 X 工作"。

## 模块边界

| 文件 | 在本主题验什么 |
|---|---|
| `electron/main/services/terminal-sessions.service.ts` | `ownerWindowId` 字段 + `getAll({ownerWindowId})` 过滤 + `removeByOwner()` 摘除 |
| `electron/main/ipc/terminal.ipc.ts` | `create` 写入 sender `win.id`;`list_sessions` 按 sender win.id 过滤;`sessions_changed` 按 owner 路由 |
| `electron/main/ipc/terminal.ipc.ts` | `makeWindowClosedCleanup({service, sessionStore})` 工厂(window closed 时被调) |

更细粒度的单元行为(`add` / `getAll` / `subscribe` 等的全部 case)在
[`terminal-sessions-service`](../terminal-sessions-service/) 与 [`terminal-ipc`](../terminal-ipc/) 主题持。
本主题只断**跨层 invariant**:owner 字段贯穿 sessionStore → IPC handler → broadcast 推送,以及
关闭清理 helper 的端到端语义。

## 关键行为

### 创建:写入 sender owner

- `create` IPC handler 在调 `sessionStore.add` 时,把 `BrowserWindow.fromWebContents(event.sender).id`
  传入 `ownerWindowId`。renderer 端**不**自报 ownerWindowId(信任来源仅为 sender)。
- handler 拿不到 `BrowserWindow`(sender 已 destroy 等异常)→ 抛 `TERMINAL_NO_WINDOW`,
  **不**调 `sessionStore.add` / `service.createTerminal`。

### 列表:按 sender owner 过滤

- `list_sessions` IPC handler 走与 `create` 同款 `ipcMain.handle` 包装,拿
  `event.sender` 推断 ownerWindowId,调 `sessionStore.getAll({ ownerWindowId })`。
- renderer 看不到其他 window 的 session(即使 renderer 端不做过滤)。

### 推送:按 owner 路由 broadcast

- `sessions_changed` 订阅 fn 在收到全量快照时,**遍历当前所有 BrowserWindow**,
  对每个 window 单独 push `sessionStore.getAll({ ownerWindowId: win.id })`。
- 一个 window 自己创建/删除 session → 只该 window 收到非空 snapshot(其它 window 收
  自己原有 snapshot,不变化也不必收;但本 spec 不强制"完全不推空" — 实装可选)。
- **agent session 与 user session 同等严格 per-owner**:不开"agent 广播到所有 window"
  后门。一旦 `ownerWindowId` 字段被设置成 X(无论 fallback / hello / 显式),后续
  list / broadcast 都按 X 工作 — `originHint` 不影响可见域。
  > 历史:topic-05 `86c1799` 曾给 agent session 开宽口径 broadcast(`originHint==='agent' ||
  > ownerWindowId===w.id`)绕过 fallback 选错窗的问题,导致 sessions 跨 window 漏出且与
  > `listSessions` 语义错配。已回退;正确做法是修 fallback / hello 路由,不是放宽广播。

### 关闭:摘 metadata + kill PTY

- `makeWindowClosedCleanup({ service, sessionStore })` 返回 `(ownerWindowId) => void`。
- 调用后:
  1. `sessionStore.removeByOwner(ownerWindowId)` 摘所有 owner=入参的 sessions,返回摘下的 id 列表
  2. 对每个返回 id,`if (service.has(id)) service.kill(id)`
- removeByOwner 触发 subscribe 推送一次新快照(全量),IPC 层 broadcast 时按 owner 重新过滤
  → 该 owner 在 BrowserWindow 列表已不存在(window 已 closed),其它 window 收到自己仍有的 sessions(无变化)。

### 并发隔离不变量(集成断言)

- windowA(id=11)创建 1 个 → windowA.list = 1 个、windowB.list = 0 个
- windowB(id=22)创建 2 个 → windowA.list = 1 个、windowB.list = 2 个
- windowA 关闭 → 全局 sessionStore 还有 2 个(都是 windowB 的);kill 被调 1 次(windowA 那个)
- windowB 关闭 → 全局清空;kill 共被调 3 次

## 不在本主题验证

- `terminal-sessions.service` 单方法逐 case(在 `terminal-sessions-service` 主题)
- IPC create / list / remove handler 的 schema / shell allowlist 等(在 `terminal-ipc` 主题)
- PTY 真实 spawn / exit 联动(留 E2E)
- MCP agent 创建 session 时的 ownerWindowId 来源(留 #29 Phase 2 主题)
- renderer 端 store(`terminal.store`)是否过滤(本 phase 不改 renderer)
