# popout 契约 (M5)

行为契约——用户感知:

## 触发

- 任意 group 的 tab bar 右侧有"弹出"按钮(箭头图标)。
- 点击 → 当前 active panel 弹出到独立的 BrowserWindow,主窗口该 group 仍存在(若空则被回收)。

## 子窗口外观

- 子窗口标题与主窗口一致(`document.title`),背景同色 `#020617`。
- 子窗口启用与主窗口同款 preload(`window.api` 可用)。
- 子窗口不再渲染 DockShell / Splash / EmptyState,只显示被弹出的 panel。

## 关闭与回收

- 关闭子窗口 → dockview 默认行为把 panel 还给主窗口最近的 group。
- 子窗口 reload(刷新)→ 不崩溃。
- 主窗口关闭 → 所有 popout 子窗口同时关闭(dockview 内部用 beforeunload 钩)。

## 安全

- 子窗口仍走 `contextIsolation: true` / `sandbox: true` / `nodeIntegration: false`。
- 子窗口的 `window.open` 同样受 windowOpenHandler 管控(同源 allow,外站走 shell.openExternal)。

## 不在本主题验证

- 实际 BrowserWindow 弹出 / 拖拽手感(手测)。
- 多 popout 内存压力(留 v1 收尾压测)。

## 可机检的契约

- `isPopoutWindow()` 在 `?popout=1` 下返回 true。
- `popoutUrlFor(href)` 给任意 URL 加上 `popout=1` 查询。
