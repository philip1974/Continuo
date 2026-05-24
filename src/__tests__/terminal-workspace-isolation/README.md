# terminal-workspace-isolation

行为契约:**terminal sessions 按 workspace 根目录跟随显示**(同窗换 workspace 时旧
terminal 不立刻销毁)。本 topic 配合
[`terminal-window-isolation`](../terminal-window-isolation/) 的窗口级隔离,把
"folder-aware"语义补在窗口级隔离之上 — 同窗多 workspace 切换是常态(VSCode 风
"打开文件夹")。

> 触发:用户报 "项目的 terminal session 好像没有根据文件夹隔离" 与 "在 ~/proj
> 新建的 terminal 默认路径是 ~"。前者由本 topic 锁约束;后者由 hydrate gate
> + cwd 兜底解决(见 `terminal-sessions-service` / `terminal-ipc` 主题增补)。

## 决策

- **session metadata 加 `workspaceRoot?: string` 字段**;未传 = 全局会话(所有
  workspace 都可见,主要给 MCP agent 用)。
- **主进程 single source of truth**:main 端 `terminal-sessions.service` 维护
  workspaceRoot 字段,renderer 端只读 snapshot,不本地复制(避免双信源)。
- **持久化 cwd 兜底**:老 tabsState 里残留 leaf cwd=undefined 的位置,hydrate
  时按当前 workspaceRoot 补齐。

## 关键行为

### create:workspaceRoot 透传

- renderer `coApi.terminal.create` 调用方(`terminal.new` command / HeaderActions
  + 按钮 / Explorer "Open in Terminal")都把当前
  `useWorkspaceStore.getState().root` 带上去。
- main `makeCreateHandler` 把入参 `workspaceRoot` 透传到 `sessionStore.add`,
  落到 `MainTerminalSession.workspaceRoot`。
- 未传字段 = 全局会话(不写 `workspaceRoot` 字段),sessions snapshot 里也不带。

### 持久化 cwd 兜底:老 tabsState 自愈

- 升级路径上若发现 panel 持久化的 cwd=undefined,hydrate 时按当前
  workspaceRoot 填充,防御旧版本写出的记录在升级后仍把 PTY 落 `~`。

## 模块边界

| 文件 | 在本主题验什么 |
|---|---|
| `electron/main/services/terminal-sessions.service.ts` | `MainTerminalSession.workspaceRoot` 字段 round-trip |
| `electron/main/ipc/terminal.ipc.ts` | `createInputSchema` 接 `workspaceRoot` + `makeCreateHandler` 透传到 sessionStore |

更细的字段单测在 [`terminal-sessions-service`](../terminal-sessions-service/) /
[`terminal-ipc`](../terminal-ipc/) 主题增补;本主题只断 main 端跨层 invariant
— workspaceRoot 从 create → store → snapshot 一路对得上。

## 不在本主题验证

- per-window 隔离(在 `terminal-window-isolation`)
- 主进程 `resolveTerminalCwd` 的 fallback 链(在 `terminal-pane-internal-split`)
- Explorer 持久化的 read/write(在 `explorer-stores`)
