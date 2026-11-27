# TitleBar(macOS 顶栏:workspace + active file 文件名)

行为契约:**`<TitleBar />` 显示 `${activeFileName}${dirty ? ' ●' : ''}  ·  ${workspaceName}`,
没有 active 时只显示 workspace,都没有时显示 'Continuo'。具备 -webkit-app-region:drag 让用户拖窗。
主窗活动的是终端等非编辑器 dock 面板时显示该面板名;窗口标题(`document.title`)同步(见 `chrome-active-panel`)。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/TitleBar.tsx` | UI |
| `electron/main/ipc/window.ipc.ts` | `window:is-full-screen` 查询、`wireFullScreenNotify` 推送 `window:full-screen-changed` |
| `title-bar-full-screen-ipc.spec.ts` | 全屏状态 IPC |
| `tests/e2e/title-bar-traffic-lights.spec.ts` | 真实 Electron:400 宽窗口长标题不进红绿灯区;全屏 / 退出全屏切换留位 |

## 关键行为

- 无 root + 无 active → 'Continuo'
- 仅有 root → basename(root)
- 仅有 active.filePath → basename(filePath)
- active 与 root 都有 → `${file}  ·  ${ws}`
- active.dirty=true → 文件名后追加 ' ●'

## 界面缩放(macOS)

- macOS(`titleBarStyle: 'hiddenInset'`)的红绿灯是原生控件,不随网页缩放;标题栏(CSS `h-9`)若随 ⌘- 变矮,红绿灯会伸出
  标题栏。照 VSCode `titlebarPart` 的 counter-zoom(标题栏没有可缩放的自定义项时 `zoom: calc(1 / var(--zoom-factor))`):
  标题栏按 `1 / 缩放系数` 反向缩放,高度与文字在任何缩放(缩小与放大)下都与 100% 时相同;100% 时不加 `zoom`。
- 缩放系数经 preload `coApi.window.getZoomFactor()`(`webFrame.getZoomFactor()`,同步)读取;页面缩放改变视口的 CSS 尺寸并派发
  `resize`,标题栏据此更新。取不到(无 preload)按 1。非 macOS 是原生标题栏,不干预。

## 红绿灯留位(macOS)

- 非全屏:标题两侧各留 80px(对称,标题仍居中;长标题截断时不压左侧原生红绿灯)。VSCode mac 给
  `.window-controls-container` 留 70px(`titleBarStyle: hidden`);Continuo 用 `hiddenInset`,红绿灯更靠里,多留 10px。
- 全屏:红绿灯隐藏(VSCode `.monaco-workbench.fullscreen .window-controls-container { display: none }`),两侧回到 48px。
  全屏状态:挂载时 `coApi.window.isFullScreen()`(`window:is-full-screen`)查询初值,之后跟随 main 在
  `enter-full-screen` / `leave-full-screen` 时推送的 `window:full-screen-changed`;推送先到时不被迟到的初值覆盖。
- 非 macOS(原生标题栏):48px,不查询全屏。
- 规范:`title-bar.spec.tsx`(渲染)、`title-bar-full-screen-ipc.spec.ts`(main)
