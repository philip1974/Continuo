# terminal-store (M-Terminal Step T3 + Agent Terminal MCP P1)

行为契约:**Terminal sessions 在 renderer 端是镜像,真相源在 main**。
store 只负责接收 main 推的 snapshot(整体替换)。「哪个终端处于活动状态」由 dockview 的活动 panel 决定,
store 不记;也没有 renderer 侧的改名(此前的 activeId / setActive / renameSession / customTitles 没有任何
UI 入口,已删除)。
所有 mutation(add / remove / setExited)由 main 主动推快照触发,renderer **不**直接改 sessions。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §3, §9
> 真相源:`src/__tests__/terminal-sessions-service/`

## 模块

| 文件 | 职责 |
|---|---|
| `src/stores/terminal.store.ts` | sessions(镜像)+ replaceSnapshot + ingress 过滤 / 索引等纯函数 |

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

- 用 main 推来的列表整体替换 `sessions`(顺序以 main 为准;字段变化即新对象)
- 同一个数组引用、或新旧都为空 → 不通知订阅者

## 已删除的 actions(行为变更)

`addSession` / `removeSession` / `setExited` / `clearAll` 全部删除。
原因:这些都是 mutation,真相源搬到 main 后必须由 main 推。renderer 调
`coApi.terminal.create` / `coApi.terminal.remove` 触发 main 改 → main 推
`sessions_changed` → renderer 通过 `replaceSnapshot` 应用。

`activeId` / `setActive` / `renameSession` / `customTitles` / `nextActiveAfterClose` / `applySnapshot`
也已删除:生产代码里没有任何地方读 activeId 或调用改名,终端页签的活动态与标题由 dockview + main 的
session 标题决定。

## 不在本主题验证

- IPC `sessions_changed` 推送链路 — 在 `terminal-ipc` 与 E2E
- coApi.terminal.* 调用形态 — 在 `co-api` topic
- TerminalPanel mount 时 listSessions 流程 — 留 E2E
