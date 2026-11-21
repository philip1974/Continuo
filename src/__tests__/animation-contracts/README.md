# 动画落点契约 (M3)

行为契约——用户在主窗口操作时应感知到:

## 落点 ① · Tab active indicator

- 同一 group 内切换 tab,**底部蓝色 indicator 平滑滑过**而非闪现。
- 跨 group 不共享 indicator(避免"飞越"两个区域)。
- indicator 用 spring(stiffness 500 / damping 35)。

## 落点 ② · Panel 进场

- 新增 panel 时,内容**淡入 + 微下移 + 微放大**(220ms,ease `[0.32, 0.72, 0, 1]`)。
- 退场动画由 `PanelMount` 的 EXIT 动画实现(`PANEL_MOUNT_EXIT` / `EXIT_DURATION_MS` 定义于 `src/shell/motion/tokens.ts`,由 `PanelMount.tsx` 播放;延迟关闭见 `src/shell/dock/wrap-panel-close.ts`),不在本规范范围。

## 全局 reduced-motion

- 系统 `prefers-reduced-motion: reduce` → `<MotionConfig reducedMotion="user">` 让 transform / 布局类属性动画瞬时到位。
- 其它属性(opacity、SVG 属性等)MotionConfig 不管,需组件自行判断(如 BackgroundBeams,见 `decor-contracts/`)。

## 特性集懒加载(lazy-motion.spec.tsx)

- 组件一律用轻量 `m.*`;App 根 `<LazyMotion features={…} strict>` 异步加载 `domMax`(`src/shell/motion-features.ts`,单独成 chunk)。layoutId 需要 layout 特性,故用 domMax 而非 domAnimation。
- 首屏 main-app 不再静态包含完整特性集;特性加载完成前 `m.*` 按 initial 渲染,动画晚一帧开始。
- `strict`:任何残留 `motion.*` 渲染即报错;源码钉禁止 `motion` 具名导入 / `<motion.` / framer-motion。

## 不在本主题验证

- 实际帧率、视觉滑动平滑度(浏览器/devtools 手工)。
- React 19 + Motion 的并发兼容性(风险 R4,M3 验收手动跑 100 次切 tab)。

## 可机检的契约

- `tabIndicatorLayoutId(groupId)` 返回 `tab-indicator-${groupId}`(SharedTab 唯一性的关键)。
- `PANEL_MOUNT_TRANSITION` 常量值固定(防止误改)。
