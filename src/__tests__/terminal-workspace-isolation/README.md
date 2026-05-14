# terminal-workspace-isolation

行为契约:**terminal sessions 按 workspace 根目录跟随显示**(同窗换 workspace 时旧
terminal 不立刻销毁,只是从可见列表里隐藏;切回原 workspace 即恢复)。本 topic
配合 [`terminal-window-isolation`](../terminal-window-isolation/) 的窗口级隔离,把
"folder-aware"语义补在窗口级隔离之上 — 同窗多 workspace 切换是常态(VSCode 风
"打开文件夹")。

> 触发:用户报 "项目的 terminal session 好像没有根据文件夹隔离" 与 "在 ~/proj
> 新建的 terminal 默认路径是 ~"。前者由本 topic 锁约束;后者由 hydrate gate
> + cwd 兜底解决(见 `terminal-sessions-service` / `terminal-ipc` 主题增补)。

## 决策

- **session metadata 加 `workspaceRoot?: string` 字段**;未传 = 全局会话(所有
  workspace 都可见,主要给 MCP agent 用)。
- **过滤发生在 renderer 端**;主进程依旧只按 `ownerWindowId` 路由广播,不维护
  per-window 当前 workspace 的副本(避免双信源)。
- **render filter**:
  `t.workspaceRoot === undefined || t.workspaceRoot === currentWorkspaceRoot`
- **hydrate gate**:`workspace.store.hydrated` 标志 — Explorer 持久化层完成
  hydrate 后置 true;InternalTerminalPanel 在 hydrated 之前不跑 HYDRATE,避免
  race 到 `root=null` → 默认 leaf cwd 落 `undefined` → 主进程 fallback `~`。
- **持久化 cwd 兜底**:老 tabsState 里残留 leaf cwd=undefined 的位置,hydrate
  时按当前 workspaceRoot 补齐。

## 关键行为

### create:workspaceRoot 透传

- renderer 任何 `coApi.terminal.create` 入口(InternalTerminalPanel.onNew /
  LegacyTerminalPanel.handleNew / Explorer "Open in Terminal" / splitTerminal)
  都把当前 `useWorkspaceStore.getState().root` 带上去。
- main `makeCreateHandler` 把入参 `workspaceRoot` 透传到 `sessionStore.add`,
  落到 `MainTerminalSession.workspaceRoot`。
- 未传字段 = 全局会话(不写 `workspaceRoot` 字段),sessions snapshot 里也不带。

### render filter:跨 workspace 切换的可见性

- `InternalTerminalPanel` 渲染 `state.tabs` 前过滤:
  `visible = t.workspaceRoot === undefined || t.workspaceRoot === currentRoot`
- 切换 workspace → `useWorkspaceStore.root` 变 → React 重渲 → 可见 tab 集合换。
  state.tabs 保留全部(包括别的 workspace 的),PTY 不动,切回去即恢复。
- activeTabId 落到 hidden tab → 用第一个 visible tab 作 effectiveActiveId 兜底。

### hydrate gate:等 workspace 持久化加载完成

- `useWorkspaceStore.hydrated` 起始 false,`initExplorerPersistence` 最末调
  `markHydrated()` 置 true(不论 read 成功 / 失败 / 没有 explorer.json)。
- `InternalTerminalPanel` HYDRATE useEffect 在 `workspaceHydrated === true`
  之前不 dispatch HYDRATE(也就不进入"加载布局…"之外的状态)。
- 这样保证 `defaultPersistedState(workspaceRoot ?? undefined)` 在 workspace
  已恢复后才执行,defaul leaf 的 cwd 写对。

### 持久化 cwd 兜底:老 tabsState 自愈

- `normalizePersistedCwd(persisted, fallback)`:遍历 panel paneTree,leaf 上
  `cwd` 为空时填 fallback(= current workspaceRoot)。
- 防御过去版本写出的 `cwd: undefined` 持久化记录在升级后仍把 PTY 落 `~`。

## 模块边界

| 文件 | 在本主题验什么 |
|---|---|
| `electron/main/services/terminal-sessions.service.ts` | `MainTerminalSession.workspaceRoot` 字段 round-trip |
| `electron/main/ipc/terminal.ipc.ts` | `createInputSchema` 接 `workspaceRoot` + `makeCreateHandler` 透传到 sessionStore |
| `src/panels/Terminal/panelReducer.ts` | `TabState.workspaceRoot` 在 ADD_TAB / HYDRATE / ATTACH 路径上的写入与 ENQUEUE_SPAWN 继承 |
| `src/panels/Terminal/TerminalPanel.tsx` | render filter:`visibleTabs = state.tabs.filter(workspaceRoot match)` |
| `src/stores/workspace.store.ts` | `hydrated` 标志 + `markHydrated()` |

更细的字段单测在 [`terminal-sessions-service`](../terminal-sessions-service/) /
[`terminal-ipc`](../terminal-ipc/) /
[`terminal-pane-internal-split`](../terminal-pane-internal-split/) 主题增补;
本主题只断"跨层 invariant" — workspaceRoot 从 create → store → snapshot →
render filter 一路对得上。

## 不在本主题验证

- per-window 隔离(在 `terminal-window-isolation`)
- 主进程 `resolveTerminalCwd` 的 fallback 链(在 `terminal-pane-internal-split`)
- Explorer 持久化的 read/write(在 `explorer-stores`)
