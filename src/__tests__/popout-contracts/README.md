# popout 契约 (M5)

行为契约——用户感知:

## 触发

- 任意 group 的 tab bar 右侧有"弹出"按钮(箭头图标)。
- 点击 → 当前 active panel 弹出到独立的 BrowserWindow,主窗口该 group 仍存在(若空则被回收)。

## 子窗口外观

- 子窗口标题与主窗口一致(`document.title`),背景同色 `#020617`。
- 子窗口启用与主窗口同款 preload(preload API 可用,renderer 经 `coApi.*` 调用)。
- 子窗口不再渲染 DockShell / Splash / EmptyState,只显示被弹出的 panel。

## 关闭与回收

- 关闭子窗口 → dockview 默认行为把 panel 还给主窗口最近的 group。
- 子窗口 reload(刷新)→ 不崩溃。
- 主窗口关闭 → 所有 popout 子窗口同时关闭(dockview 内部用 beforeunload 钩)。

## 子窗能否打开(window.open 放行)

- 只允许指向本应用自己的 renderer 入口,且判定与主窗的加载方式一致(`electron/main/window-open-policy.ts`):
  - 有 dev server(未打包且设了 `ELECTRON_RENDERER_URL`)→ 只认同源 URL;
  - 否则(已打包,或未打包但直接跑构建产物:预览 / e2e)→ 只认受信的 renderer 文件入口(精确 pathname)。
- 此前只按「是否打包」分支:未打包且没有 dev server 时所有 popout 都被拒,子窗开不出来。
- 且只为 popout 放行:URL 的 query 必须**恰好只有** `popout=1`(`isPopoutOnlyUrl`)。带 `workspace` / `fresh` / `windowSeq` / `spike` 等启动参数的本应用入口一律拒 —— 否则页面内容(Markdown 预览中键点链接、`target=_blank`)能开出带完整 preload、以攻击者指定目录为根的应用窗口(安全 L1)。
- 有 popout 窗口时退出应用:不因 popout 窗口不应答关窗 flush 而等满 10s(e2e `quit-with-popout`)。

## 窗口不被页面内容带离应用

- 页面发起的跨文档导航(点击链接、`location` 赋值、`location.reload()`、iframe 加载)在**任何 frame** 一律拦下(`installNavigationGuard` 挂在 `will-frame-navigate` 上);dev 与打包版同一套规则。窗口内容只由 main 经 `loadURL` / `loadFile` / `webContents.reload()`(菜单 View → Reload)加载,这些由浏览器侧发起,不经守卫。
- 唯一放行:popout 子窗的**首次**加载 —— 尚未提交任何文档的窗口,主框架导航到 `windowOpenHandler` 放行的那种 URL(本应用入口且 query 恰为 `popout=1`)。子窗已有文档后,或目标是别的 URL(如 opener 抢先改 `w.location`),照拦。
- 被拦下的主框架 URL:离开本应用的按与 `window.open` 拒绝分支相同的外链白名单(http / https / mailto,限长)转交系统打开,其余静默丢弃;指回本应用入口的(含 `location.reload()`、Vite HMR 整页刷新)与 DevTools 自身的导航只拦不转交。子 frame 的导航只拦不转交。
- 取舍:打包版此前就是这样全拦(由已删除的 topic-45 spike 守卫顺带承担),这里显式化并让 dev 一致。代价是 dev 下 Vite 的整页刷新不再自动生效,需手动 Cmd+R / View → Reload。

## 安全

- 子窗口仍走 `contextIsolation: true` / `sandbox: true` / `nodeIntegration: false`。
- 子窗口的 `window.open` 同样受 windowOpenHandler 管控(同源 allow,外站走 shell.openExternal)。

## 不在本主题验证

- 实际 BrowserWindow 弹出 / 拖拽手感(手测)。
- 多 popout 内存压力(留 v1 收尾压测)。

## 可机检的契约

- `isPopoutWindow()` 在 `?popout=1` 下返回 true。
- `popoutUrlFor(href)` 把 URL 的查询替换为仅 `popout=1`(主窗启动参数不带进子窗)。
- `isPopoutOnlyUrl(url)` 仅在查询恰为 `popout=1` 时为真;windowOpenHandler 放行 = 本应用入口 且 `isPopoutOnlyUrl`。
