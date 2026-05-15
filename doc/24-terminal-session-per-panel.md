# 24 — 1 PTY session = 1 dockview panel（架构决策）

> 类型：架构决策 / 重构记录
> 日期：2026-05-15
> 状态：已落地（topic-07）
> 关联：topic-03（pane 内 BSP）、topic-05（tab 拖拽 split）的最终演化结论

## 决策

**Terminal 子系统不再维护自有的 layout 模型。每个 PTY session 对应一个 dockview panel，layout 完全交由 dockview 管。**

## 上下文（演化轨迹）

| topic | 模型 | 痛点 |
|---|---|---|
| 早期 | singleton dockview panel + 内部 TabNav | 单 panel 内只能纵向叠 tabs，没法并排看两个 terminal |
| topic-03 | 单 panel + 内部 BSP (binary space partition) | 实现了 iTerm2 风内嵌分屏，但 BSP tree / focus / drop zone 全自写，~2000 LOC |
| topic-05 | 单 panel + 内部 BSP + tab 拖拽外 promote / 内 split | 拖拽语义复杂；多窗口 + persist + dockview overlay 冲突 |
| **topic-07** | **每 session 一个 dockview panel，无内部 layout** | 见下文 |

topic-03 和 topic-05 的实现工作量巨大（合计 ~3500 LOC 自有 layout 代码 + ~1500 LOC 测试），但用户感知到的差异其实只有一个：**能不能并排看两个 terminal**。dockview 原生 split / drag 就能做到这件事，只要每个 PTY 各占一个 panel。

## 取舍

### 选择 dockview-per-panel 的理由

1. **删 ~6500 行**：topic-07 net -4677 LOC，绝大部分是删 PaneController / paneTree / panelReducer / TabNav / TAB_DRAG_MIME / 自有 drop overlay。
2. **拖拽语义统一**：用户在 editor、terminal、explorer 之间拖 panel 用同一组 dockview 手势，不再"editor 一种拖法，terminal 另一种"。
3. **多窗口免修**：dockview 已支持 panel 跨窗口拖拽（PopoutHost）。我们的 TAB_DRAG_MIME 自有协议在多窗口下需要单独写跨窗口 channel，topic-07 后这块归零。
4. **persist 由 dockview 一手包**：layout 序列化反序列化、orphan panel 清理（`sanitizePersistedDockLayout`）都集中在 DockShell.tsx 一处。
5. **focus 模型简化**：dockview activePanel 就是真相源，不再有 "tab.activeId vs leaf.focusedLeafId vs pane.focusedTabId" 三层状态同步。

### 代价

1. **panel tab 高度浪费**：每个 terminal 都带一条 dockview tab bar（28px）。topic-03 / 05 的内嵌 BSP 在多 terminal 场景能省掉这条。
   - 缓解：1080p 屏上 28px ≈ 2.6% 高度，多 terminal 时也只多消耗一条（dockview 同 group 共享 tab bar）。可接受。
2. **persist 大小膨胀**：每个 terminal panel 都进 layout.json，session 多时 layout 文件变大。
   - 缓解：`sanitizePersistedDockLayout` 重启时整删 terminal panel（terminal 决策 #4 不持久化 sessions），文件不会无限长。
3. **agent 创建 panel 的 focus 模型要 hack**：dockview 默认 addPanel 抢 focus，"agent 不抢"要用 setActive-back-to-previous 兜（见 doc/23）。
   - 缓解：成本就是 reconciler 里 ~5 行。
4. **失去内嵌 BSP 的"超紧凑分屏"**：dockview 拖拽并排是 group 维度的，不能在一个 panel 里塞两个 PTY 的内部上下分屏。
   - 评估：实际使用中需要这种"panel 内分屏"的场景极少。用户调研结果（topic-05 验收后的反馈）：从未主动用过内嵌 BSP。删掉零损失。

## 真相源边界

| 层 | 真相源 | 备注 |
|---|---|---|
| PTY 进程 | electron main `terminal-sessions.service` | topic-07 不动 |
| 会话元数据（id / cwd / origin / createdAt） | main service + IPC push | renderer mirror 在 `terminal.store` |
| renderer session mirror | `useTerminalStore.sessions` | 由 `TerminalSessionsSync` 从 main 拉 + 订阅 |
| panel 位置 / 顺序 / focus | dockview `api`（DockShell 内） | renderer 唯一 layout 真相源 |
| panel ↔ session 桥 | `DockReconciler` | 单向 diff：sessions 变 → 增删 panel；不反向同步 |

关键不变量：**panel ↔ session 通过 `panelIdFor(sessionId)` 一对一映射**。reconciler 是声明式的（diff 而非命令式 addPanel），删 BSP / TabNav 之后 layout 状态机消失了。

## 实现要点

### DockReconciler（`src/shell/dock/DockReconciler.ts`）

```ts
// 入：previousSessions, nextSessions（来自 store 订阅）
// 出：调用 api.addPanel / api.getPanel(panelId).api.close
// 副作用：markPanelCloseSuppressed 防 close 触发反向 remove session
```

三个阶段：
1. **added**：按 `createdAt` 升序逐个 addPanel；第一个无 position，后续 `referencePanel: 前一个`, `direction: 'right'`
2. **removed**：previousSessions 中不在 nextSessions 的，markSuppressed + `panel.api.close()`
3. **title 更新**：existing sessions 的 `customTitles` 变化时 `panel.api.setTitle`

### onDidRemovePanel（`src/shell/dock/DockShell.tsx`）

```ts
event.api.onDidRemovePanel((panel) => {
  useClosingStore.getState().unmark(panel.id);
  void handleTerminalPanelRemoved({  // 反向通知 main remove session
    panel, api: event.api,
    removeSession: (sid) => coApi.terminal.remove(sid).then(() => undefined),
  });
});
```

`handleTerminalPanelRemoved` 内部用 microtask 重查 `api.getPanel(panelId)` 区分"真 close"vs"dockview 内部 move"。

## 防回归

| spec | 锁定行为 |
|---|---|
| `src/__tests__/terminal-panel-as-dockview-panel/core-contract.spec.ts` | reconciler add/remove 幂等 + suppress flag + move 识别 |
| `src/__tests__/agent-create-as-new-panel/addpanel-position.spec.ts` | agent 不抢 focus；user pendingFocus 路径 setActive；batch add 按 createdAt 升序 |
| `src/__tests__/terminal-panel-empty-dock/empty-state.spec.ts` | 关最后一个 panel → EmptyState；不自动重建 |
| `src/__tests__/terminal-sessions-sync/sync.spec.ts` | listSessions + onSessionsChanged → store mirror |

## 删除清单（topic-07 Op8）

```
src/panels/Terminal/PaneController.ts
src/panels/Terminal/panelReducer.ts
src/panels/Terminal/paneTree.ts
src/panels/Terminal/TerminalLeaf.tsx
src/panels/Terminal/TerminalPaneTree.tsx
src/panels/Terminal/TerminalTabs.tsx
src/panels/Terminal/PaneSplitter.tsx
src/panels/Terminal/spawnLeaf.ts（部分）
src/shell/dnd/TAB_DRAG_MIME.ts
src/shell/dnd/PromoteDropOverlay.tsx
... + 对应 __tests__/ 目录 4 个
```

合计 -6572 行（含测试），换来 +1895 行（新 reconciler + sync + TerminalPanelView 等），净 **-4677 行**。

## 未决 / followup

1. **gui-test-infrastructure-playwright**（建议下一个 topic）：补 Playwright + electron 集成，把 topic-07 的 5 条 manual smoke（T17-T21）转成 real-test scenarios，挂上 `dl-verify` Phase E.5 gate。
2. **多窗口下 reconciler 的 windowId 隔离**：DockReconciler 目前订阅全局 `useTerminalStore.sessions`，每个窗口都会收到所有 session 变更。如果用户在窗 A 创建 terminal，窗 B 也会试图 addPanel — 需要 session 元数据带 `windowId` 字段并在 reconciler 里 filter。topic-07 暂未触发（单窗口跑），但多窗口场景上线前必处理。
