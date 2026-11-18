# 装饰层契约 (M4)

行为契约——用户感知:

## 启动 Spotlight

- App 启动 → 立即看到 Spotlight + "Continuo" 渐变标题盖在屏幕上(splash overlay)。
- DockShell 完成 layout 注入(`fromJSON` 或 `applyDefaultLayout`)且终端首个 sessions 快照已 reconcile(事件式屏障,带安全上限,见 `splash-terminal-ready-barrier/`)→ splash **完全 unmount**(不是 `display: none`)。
- 不设最短展示时长:布局就绪即 unmount(性能,原 600ms 最短露脸让布局快速就绪时仍被遮罩挡 ~500ms 才可交互;见 `decor-shell/splash-lifecycle.spec.tsx`)。

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
