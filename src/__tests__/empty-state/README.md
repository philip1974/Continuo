# EmptyState(dock 全空时占位)

行为契约:**`<EmptyState onRestore />` 显示「所有面板都关掉了」与一个「恢复默认布局」按钮。
visibilityState='hidden' 或窗口失焦时不挂载装饰用 BackgroundBeams 节电(backgroundThrottling:false 下最小化/遮挡仍报 visible,靠焦点兜底)。点按钮触发 onRestore。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/EmptyState.tsx` | UI |

## 关键行为

- 渲染 data-testid='empty-state' 容器;容器带 `data-dock-empty`、tabIndex=-1:主窗无面板时 F6 / ⇧F6 的 dock 区域落点(VSCode:主窗保留带水印的空编辑器组,F6 可达)
- DockShell 按**主窗内**(grid / floating)面板数判空(`isMainWindowDockEmpty`):面板全弹出到 popout 子窗时主窗同样显示空态
- 文案「所有面板都关掉了」
- 点「恢复默认布局」 → onRestore
- visibilityState !== 'hidden' → 渲染 BackgroundBeams(SVG)
- visibilityState === 'hidden' → 不渲染 BackgroundBeams
- visibilitychange 事件 → 切换显示
- 窗口 blur → 不渲染 BackgroundBeams;focus → 恢复
- 挂载时 document.hasFocus() 为 false → 不渲染 BackgroundBeams
