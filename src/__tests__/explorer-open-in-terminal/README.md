# explorer-open-in-terminal — Explorer 右键「在终端中打开」

终端 panel 是 per-session id(`terminal-<sessionId>`),只由 `DockReconciler` 依 live session 列表建出。

## 行为契约

- `terminal.create({ cwd: <目录>, workspaceRoot: <当前 root> })` 成功 → `setPendingFocus(<新 session id>)`
  (与 Cmd+T / `createUserTerminal` 相同),由 Reconciler 建 session-bound 面板并聚焦。
- **不**调通用 `openOrFocusPanel('terminal', ...)`:`getPanel('terminal')` 恒为空,会 addPanel 出 id='terminal'、
  无 `params.sessionId` 的坏面板(TerminalPanelView 自动关闭);布局恢复期间还会被排队重放。
- create 失败(ok:false)→ 错误提示,不请求聚焦。

## 用例

- `open-in-terminal.spec.tsx`
