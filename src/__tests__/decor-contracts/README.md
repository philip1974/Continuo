# 装饰层契约 (M4)

行为契约——用户感知:

## 启动 Spotlight

- App 启动 → 立即看到 Spotlight + "Continuo" 渐变标题盖在屏幕上(splash overlay)。
- DockShell 完成 layout 注入(`fromJSON` 或 `applyDefaultLayout`)→ splash **完全 unmount**(不是 `display: none`)。
- 期间布局加载小于 200ms 时也至少给 spotlight 动画一个最短露脸时长,避免闪一下就消失。

## 空状态 Beams

- `event.api.totalPanels === 0` → 在 dock 上盖一层 EmptyState(Beams + 文案 + 恢复按钮)。
- 任意 panel 重新出现 → EmptyState **立即 unmount**,Beams SVG 也被销毁(不只是隐藏)。
- 窗口隐藏(`document.visibilityState === 'hidden'`) → SVG 动画暂停(节电)。
- `prefers-reduced-motion: reduce` → Beams 退化为静态渐变(由 `<MotionConfig reducedMotion="user">` 短路 motion 动画)。

## 不在本主题验证

- 实际 GPU 占用、视觉效果(devtools 手工)。
- Aceternity 源码精确度(已在文件头标注 source + modified)。

## 可机检的契约

- LICENSE-3RD-PARTY.md 存在且包含 Aceternity 引用。
- reduced-motion 由 motion 库的 `<MotionConfig reducedMotion="user">` 直接消费系统 mq,
  本项目无独立 hook(useReducedMotion 已删除,因 motion 内置已覆盖)。
