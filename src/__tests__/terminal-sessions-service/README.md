# terminal-sessions-service (Agent Terminal MCP Phase 1)

行为契约:**main process 端 terminal session metadata 的单一真相源**。
PTY 进程由 `terminal.service.ts` 持(本主题不重测),session metadata
(title / cwd / origin / exitCode 等)由本 service 持,renderer 通过 IPC 同步快照。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §3 + §9
>
> 决策来源:走方案 (a)——session 真相源搬到 main,renderer 是镜像。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/terminal-sessions.service.ts` | sessions Map + emitter + nextDefaultTitle 计数器 |

## MainTerminalSession 模型

```ts
interface MainTerminalSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originHint: 'user' | 'agent';
  readonly agentLabel?: string;
  readonly createdAt: number;       // ms epoch
  readonly exitCode: number | null; // null = 未退出;number = 已 exit
}
```

全字段 readonly。`setExited` 等 mutation 走 immutable 替换(`{...old, exitCode}`)。

## 关键行为

### `add(input)` → 新 session 入 Map + 推 snapshot

input 形态:
```ts
{ id, title, cwd, originHint, agentLabel? }
```
service 自动填 `createdAt = Date.now()` 和 `exitCode: null`。

- 重复 id 调 add → 抛 `TERMINAL_SESSION_DUPLICATE`(防 PTY-side bug)
- 触发所有 subscribers,传完整快照

### `get(id)` → MainTerminalSession | undefined

- 不存在 → undefined
- 存在 → 引用相等的对象

### `getAll()` → readonly MainTerminalSession[]

- 返回当前快照(数组),按 add 顺序
- 调用方**不能**改返回值(类型 readonly)
- 实现可以缓存或每次新建数组,本主题不强制

### `remove(id)` → 删 + 推

- 不存在的 id → 不触发 subscribers,不抛
- 存在 → 删 Map,推新快照

### `setExited(id, exitCode)` → 标记 + 推

- 不存在的 id → 不触发,不抛
- 存在 → immutable 替换 → 推新快照
- 重复 setExited 同 id 同 code → 仍触发(简化,不做去重)

### `nextDefaultTitle()` → "Terminal N"

**单调递增**(与现 renderer 的 `length+1` 实现不同,本 service 修复撞号 bug):
- 第 1 次调 → "Terminal 1"
- 第 2 次调 → "Terminal 2"
- 第 3 次调 → "Terminal 3"
- remove 中间一个,再调 → "Terminal 4"(不重用)

调 nextDefaultTitle 本身**不**改 sessions Map,只递增内部计数器。
计数器在 `_reset()` 时归零。

### `subscribe(fn)` → unsubscribe

- 返回 `() => void` unsubscribe 函数
- subscribe 时**不**立刻 invoke fn(emitter 模式,首次需主动调 getAll())
- 多个 subscriber:每次 mutation 全部 fn 被调
- unsubscribe 后该 fn 不再被调
- subscriber 抛错不应破坏其他 subscriber(catch 保护)

### `_reset()` (测试用)

清 Map + 计数器 + subscribers。仅 spec 用,实装不依赖。

## 不在本主题验证

- IPC 通道接线 / `terminal:sessions_changed` push event 转发 — 在 `terminal-ipc` 后续修订或 E2E
- PTY 真实 spawn / exit → setExited 联动 — 留 E2E
- snapshot 转 snake_case 给 MCP — 在 `agent-terminal-mcp-list-sessions`(已覆盖,deps 注入 fixture)
