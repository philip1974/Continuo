# terminal-sessions-sync

行为契约:`TerminalSessionsSync` 是 renderer 每个 window 顶层唯一的 terminal sessions store 同步源。组件 mount 后先调用 `coApi.terminal.listSessions()` 拉当前 window 的 snapshot,再订阅 `onSessionsChanged` 持续把 main 推送写入 `useTerminalStore.replaceSnapshot`。

该组件只同步 store,不直接操作 dockview。dockview panel add/remove 由后续 reconciler 单独消费 store 变化。
