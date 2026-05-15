# terminal-store (M-Terminal Step T3 + Agent Terminal MCP P1)

行为契约:**Terminal sessions 在 renderer 端是镜像,真相源在 main**。
store 只负责接收 main 推的 snapshot + 维护纯 UI 状态(activeId)。
所有 mutation(add / remove / setExited)由 main 主动推快照触发,renderer **不**直接改 sessions。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §3, §9
> 真相源:`src/__tests__/terminal-sessions-service/`

## 模块

| 文件 | 职责 |
|---|---|
| `src/stores/terminal.store.ts` | sessions(镜像)+ activeId + replaceSnapshot / setActive + nextActiveAfterClose 纯函数 |

## TerminalSession 模型

```ts
interface TerminalSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;                    // P1 新增,从 main 推
  readonly originHint: 'user' | 'agent';   // P1 新增
  readonly agentLabel?: string;            // P1 新增,agent 类型才有
  readonly createdAt: number;
  readonly exitCode: number | null;
  readonly ownerWindowId: number;          // BrowserWindow.id,main 推入
}
```

形态与 main 端 `MainTerminalSession` 完全同构(直接拷贝快照)。
`ownerWindowId` 是 renderer 镜像字段,用于窗口隔离的防御式过滤;renderer 不生成、不修正、
不回写该字段。

INV-2:`ownerWindowId` 创建后不可变。main service 主题锁定 add/getAll/removeByOwner 的 owner
语义;renderer store 主题只保证 snapshot 被原样镜像,后续 `dock-reconciler-windowid-filter`
主题在 ingress 处过滤异常 owner 或非法 shape。

## 关键行为

### `replaceSnapshot(newSessions)` ← 接收 main 推的快照

核心 — 必须保留旧的"关活跃 → 切下一个/前一个"切换语义,因为 main 不知道
renderer 现在 active 是哪个,只推完整 sessions 列表。算法:

1. 计算被移除的 ids = `oldSessions \ newSessions`
2. 对每个被移除的 id,**按 oldSessions 顺序**应用 `nextActiveAfterClose` 累计
3. 最后 sessions 字段直接用 newSessions 覆盖(顺序以 main 为准)

具体 case:
- 旧 active 仍在新 snapshot 中 → activeId 不变
- 旧 active 被移除 → 切下一个(在 oldSessions 顺序里);若被移除的是尾部,切前一个
- 所有 sessions 移除 → activeId = null
- 新增 session → activeId 不变(新 session 在末尾,需调用方显式 setActive 切过去)
- 仅 exitCode 等字段变化 → activeId 不变,sessions 用新对象引用

### `setActive(id)` ← UI 切换 tab

只改 activeId,不验证 id 是否在 sessions 中(允许"先 setActive 再等 snapshot 推"的 race)。

### `nextActiveAfterClose(sessions, activeId, closingId)` 纯函数(保留)

仅供 replaceSnapshot 内部使用,行为不变:
- 关 head 活跃 → 切下一个
- 关 mid 活跃 → 切下一个
- 关 tail 活跃 → 切前一个
- 关非活跃 → active 不变
- 关唯一 → activeId null
- 关不存在 id → 状态不变(返回原 sessions 引用)

仍 export 是为了保持纯函数测试面 + 给将来其它 close 流程复用。

## 已删除的 actions(行为变更)

`addSession` / `removeSession` / `setExited` / `clearAll` 全部删除。
原因:这些都是 mutation,真相源搬到 main 后必须由 main 推。renderer 调
`coApi.terminal.create` / `coApi.terminal.remove` 触发 main 改 → main 推
`sessions_changed` → renderer 通过 `replaceSnapshot` 应用。

`switchSession(id)` 重命名为 `setActive(id)`(语义未变,改名匹配它真正只动 UI)。

## 不在本主题验证

- IPC `sessions_changed` 推送链路 — 在 `terminal-ipc` 与 E2E
- coApi.terminal.* 调用形态 — 在 `co-api` topic
- TerminalPanel mount 时 listSessions 流程 — 留 E2E
