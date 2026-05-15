# 23 — dockview `inactive: true` 渲染陷阱

> 类型：决策记录 / 踩坑实录
> 日期：2026-05-15
> 状态：已确认，已写入 BDD 防回归
> 关联：topic-07-terminal-session-per-panel（hotfix H8, commit 3386788）

## 背景

topic-07 把 terminal 从"singleton dockview panel + 内部 BSP/TabNav"重构为"1 PTY session = 1 dockview panel"。需求里有一条：

> 用户在终端里跑 claude code / codex 等 agent，agent 经 MCP `terminal_create_session` 创建新 terminal 时，**不应抢走当前正在交互的 terminal 的焦点**。

直觉方案：dockview-react `api.addPanel({ ..., inactive: true })`，文档语义"加 panel 但不激活"。

## 现象

启用 `inactive: true` 后：

- agent 新 terminal panel 确实没抢 focus（tab bar 高亮仍在原 panel）✅
- 但点开那个新 panel，**屏幕全黑**。PTY 输出到了 xterm 的内部 buffer（`term.buffer.active.length > 0` 可证），屏幕一个像素都不画。
- 必须手动点击一次该 panel 让它变 active，xterm 才"突然"渲染出全部缓冲内容。

排查链（费时约 4 小时，对应 hotfix H4-H8）：

1. 怀疑 WebGL renderer 在 hidden DOM 失效 → 改 dom renderer → 仍黑
2. 怀疑容器初始 0×0 → 加 ResizeObserver 等真实尺寸再 `xterm.open()` → 仍黑（H7）
3. 怀疑 PTY 输出在 mount 前已发，xterm 没收到 → 加 buffer replay (`readHistory` IPC) → 仍黑（H6）
4. 怀疑 StrictMode 双 mount DOM 残留 → 加 `container.firstChild` 清理 → 仍黑
5. 移除 `inactive: true`，立即 setActive 回原 panel → ✅ 全部正常

## 根因

dockview 在 `inactive: true` 路径下创建的 group container 在 dom 树里**有 layout 尺寸但渲染不可见**（不是 `display:none`，也不是 0×0 — 这俩 case 1 和 2 都查过了）。xterm 的 webgl/dom renderer 在该状态下 `fit()` 拿到的尺寸正常，但实际 canvas / row span 不写像素。dockview 内部某层 CSS 或 RAF 调度让 inactive group 跳过 paint。

dockview-react 6.x 源里 `inactive` 走 `addGroup` 的非默认 mounting 分支，未公开为何 paint 被抑制。issue / docs 未提及该 side-effect。

## 决策

**禁止使用 `inactive: true` 创建带 xterm/canvas 内容的 panel。**

替代方案：

```ts
// agent 路径（不抢 focus）
const previousActivePanelId = api.activePanel?.api.id ?? null;
api.addPanel({ id, component: 'terminal', ... });  // 默认 active
if (previousActivePanelId && previousActivePanelId !== id) {
  api.getPanel(previousActivePanelId)?.api.setActive();  // 立即切回去
}
```

UX 上有 1 帧的 focus 闪烁，但用户感知不到（dockview 把新 panel 注册到 group 的瞬间就 setActive 回原 panel，DOM 还没 paint 完）。xterm 在 `addPanel` 那一帧拿到正常的 active group，渲染链完整。

## 边界

- 该结论**仅锁 dockview-react@6.0.0**（当前 package.json 版本）。dockview 上游若改 inactive group 的 paint 策略，本决策需复核。
- 普通 React 内容 panel（没用 canvas / webgl）未必触发该 bug — 我们没充分验证。**保守起见，整个 codebase 都不用 `inactive: true`**，除非未来有压测/真测说明该 panel 类型安全。

## 防回归

`src/__tests__/agent-create-as-new-panel/addpanel-position.spec.ts` 锁两条：

```ts
// 不能传 inactive: true(dockview inactive 让 xterm 渲染不可见)
expect(api.addPanel.mock.calls[0]![0]).not.toHaveProperty('inactive');
// agent 新 panel 自身不显式 setActive
expect(api.panels['terminal-agent-1']?.api.setActive).not.toHaveBeenCalled();
// 原 active panel 被显式 setActive 回去,实现"agent 不抢 focus"
expect(api.panels['terminal-old']?.api.setActive).toHaveBeenCalledTimes(1);
```

任何后续 PR 试图重启 `inactive: true` 优化都会撞红测试。

## 关联代码

- `src/shell/dock/DockReconciler.ts` `reconcileTerminalPanels` 的 `previousActivePanelId` 分支
- `src/panels/Terminal/useTerminal.ts`（H4/H5/H6/H7 留存的 fit + replay 兜底，即使 inactive 移除后这些容器初始 0×0 / lazy-mount 场景仍可能触发，保留是合理的）

## 相关 hotfix

| commit | 修复 |
|---|---|
| e744924 (H4) | inactive panel 初次 fit + onDidVisibilityChange |
| 59c62f4 (H5) | useTerminal.fit 同步 coApi.terminal.resize |
| c6d130a (H6) | mount 时从 main buffer replay 历史输出 |
| 281db37 (H7) | xterm 等容器有真实尺寸再 open |
| **3386788 (H8)** | **移除 inactive:true，改用 setActive 恢复 + 清 DOM 残留** ← 真正根因 |
