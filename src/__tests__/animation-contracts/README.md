# 动画落点契约 (M3)

行为契约——用户在主窗口操作时应感知到:

## 落点 ① · Tab active indicator

- 同一 group 内切换 tab,**底部蓝色 indicator 平滑滑过**而非闪现。
- 跨 group 不共享 indicator(避免"飞越"两个区域)。
- indicator 用 spring(stiffness 500 / damping 35)。

## 落点 ② · Panel 进场

- 新增 panel 时,内容**淡入 + 微下移 + 微放大**(220ms,ease `[0.32, 0.72, 0, 1]`)。
- 退场动画不在 v1 范围:dockview 直接控制 unmount,需 AnimatePresence 与 dockview 生命周期深度集成。

## 全局 reduced-motion

- 系统 `prefers-reduced-motion: reduce` → 所有动画立即跳到终态。
- 通过 `<MotionConfig reducedMotion="user">` 全局生效。

## 不在本主题验证

- 实际帧率、视觉滑动平滑度(浏览器/devtools 手工)。
- React 19 + Motion 的并发兼容性(风险 R4,M3 验收手动跑 100 次切 tab)。

## 可机检的契约

- `tabIndicatorLayoutId(groupId)` 返回 `tab-indicator-${groupId}`(SharedTab 唯一性的关键)。
- `PANEL_MOUNT_TRANSITION` 常量值与 doc 03 一致(防止误改)。
