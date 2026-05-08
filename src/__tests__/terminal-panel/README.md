# TerminalPanel(Terminal 主容器)

行为契约:**顶部 TerminalTabs(切/新/关)+ 主体多 TerminalView(visibility 切 active);
mount 调 listSessions 拉初始 snapshot + 订阅 onSessionsChanged;
handleNew → coApi.terminal.create + setActive;handleClose → coApi.terminal.remove;
首次 mount 若 sessions 空 → 自动 spawn 一次(模块级 flag 防 StrictMode 重复)。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Terminal/TerminalPanel.tsx` | UI |

## 关键行为

### 初始化

- mount 调 listSessions → replaceSnapshot
- 订阅 onSessionsChanged → replaceSnapshot
- unmount 调 unsub

### 自动 spawn

- 首次 mount + sessions 空 → handleNew(模块级 flag 防重)
- 已有 sessions → 不 spawn 但仍标 flag 防再触发

### handleNew

- 调 coApi.terminal.create({ cwd: workspaceRoot })
- ok=true → setActive(r.data.id)
- ok=false → alert + console.warn

### handleClose(id)

- 调 coApi.terminal.remove(id)

### 渲染

- sessions=[] → 「无活跃终端」+ 「+ 新建终端」按钮
- sessions 中 id===activeId → visibility: visible
- 其它 sessions → visibility: hidden(保留 layout 让 xterm fit 不算错)
