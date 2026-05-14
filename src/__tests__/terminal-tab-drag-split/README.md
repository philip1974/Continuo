# Terminal Tab Drag Split

Terminal panel 内嵌 tab 支持拖拽并排 + agent 通过 MCP 创建的 session 自动入 tab list。

## Behavior covered

- **Agent attach**: `terminal_create_session(target=active)` 后 origin=agent 的 session 200ms 内
  在目标 InternalTerminalPanel 内嵌 tab list 出现一个新 tab，绑现有 ptyId，**不 spawn 新 PTY**。
- **Drop to dockview region**: 拖内嵌 tab 到 dockview 外层 group 区，松手后该 tab 从原 panel
  tab list 消失，dockview 在对应方向出现 `ScopedTerminalPanel` 显示同一 session。
- **Drop to internal pane region**: 拖内嵌 tab 到本 panel 的 pane 区，松手后该 tab 从 tab list
  消失，paneTree 出现新 SplitNode，该 session 成为目标 leaf 的兄弟。
- **PTY not restarted**: 上述两种 drop 路径下 `coApi.terminal.create` / `terminal.remove` 都
  不会被调用，ptyId 不变，scrollback 连续。
- **Tab limit preflight**: 目标 panel tab 数已达上限（20）时，MCP `terminal_create_session`
  直接抛 `TERMINAL_TAB_LIMIT`，**不**创建 PTY。
- **Attach rejected reverse-notify**: renderer 端 `tryAttachExisting` 拒绝（split-tab / 上限
  / 无 panel）时主动调 `coApi.terminal.attachRejected(sid, reason)`，main 端 `removeSession`。
- **Detach forMove suppresses PANEL_EMPTY**: `DETACH_TAB({ forMove: true })` 在 state.tabs
  清零时 emit `PANEL_EMPTY_DEFERRED` 而非 `PANEL_EMPTY`，原 panel 不立即关。caller drop
  完成后调 `controller.closeIfStillEmpty()` 主动关。
- **dispatchAndCollect 同步取 effects**: 新 helper 同步跑 reducer + 同步返回 effects（不进
  全局 effectQueue），让 `PaneController.detachTab` 拿到 `leafSnapshot`。
- **Split-tab dragstart 拒**: tab.paneTree.kind === 'split' 时 onDragStart `event.preventDefault()`
  拒绝；dataTransfer 不 setData。
- **Drop hit-test fallback**: drop 落 PaneSplitter handle / gap / padding / 非 leaf 元素 →
  hit-test 失败，**不 detach** + return。
- **Popout rejects cross-window**: `isPopoutWindow() === true` 或 `payload.windowId` 不匹配
  当前窗口时，drop handler 直接 return，不 detach 也不 addPanel。
- **useTerminal no double mount**: 拖拽序列中 detach 同步完成 React commit unmount 后，
  通过 `requestAnimationFrame` 排程 `addPanel`，避免原 leaf 与 scoped panel 双订阅同一 PTY
  导致用户输入双写。
- **Agent control link stable**: 跨 detach + reattach 期间 agent `terminal_send_text` /
  `terminal_read_output` 用同一 session_id 始终 work，不报 `TERMINAL_SESSION_NOT_FOUND`，
  read_output 通过 since_seq 连续。

## Reads / Reuses

- 复用 topic-03 `panels/Terminal/paneTree.ts` 的 `LeafNode` / `SplitNode` / `mapTree` 等
  helpers。
- 复用 topic-03 `panelReducer` 现有 `ADD_TAB` / `CLOSE_TAB` / `SELECT_TAB` / `PANE_ACTION`。
- 复用 topic-02 留下的 `splitTerminal` + `dockview addPanel({position})` 基础设施。

## Not in scope (V2)

- 反向 promote（scoped panel 拖回内嵌 tab list）。
- 跨窗口拖（拖到另一个 Continuo 窗口）。
- 内嵌 tab 顺序拖拽 reorder。
- Promoted scoped panel 重启后保留 PTY — 受 `sanitizePersistedDockLayout` strip sessionId
  的现有约束，重启后 scoped panel 不保留同一 session（明确非目标）。
