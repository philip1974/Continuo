# splash-terminal-ready-barrier

行为契约:**Splash 只在「布局恢复 + 终端 sessions 首个权威快照 + Reconciler 首轮 reconcile」都完成后移除**,
不用固定最短时长。

- `DockShell` 的 `onLayoutReady`(App 据此移除 Splash)= `layoutRestored && terminalsReady`
- `terminalsReady`:当前 dock api 的 `useDockReconciler` 已按 `useTerminalStore.hydrated` 的快照完成 reconcile
- `hydrated` 由 `TerminalSessionsSync` 在首个有效快照应用时置位(非空快照与 sessions 原子写入);初始拉取失败 /
  windowId 非法时也置位,不让 Splash 白等
- 安全上限 `DOCK_TERMINAL_READY_TIMEOUT_MS`:布局已恢复而快照迟迟不到,仍报 ready,不永久遮挡
- 首个快照晚于 Reconciler 挂载到达时,其中 `createdAt` 早于恢复开始的存量 user 终端按 hydrate 处理,
  **不 setActive 抢** fromJSON 恢复的活动面板;之后真正新建的 user 终端照旧聚焦

可执行规范:`ready-barrier.spec.tsx`(DockShell 屏障 + 迟到快照不抢焦)、`sync-hydrated.spec.ts`(同步源置位 hydrated)。
