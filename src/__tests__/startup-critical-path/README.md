# startup-critical-path(冷启动关键路径 · renderer)

把只依赖部分启动数据的步骤从更长的等待链上拆下来,行为保持。

## 1 — 只依赖 root 的消费方等 `rootRestored`,不等编辑器 tab 读盘

`workspace.hydrated` 在 `hydrateEditorTabs`(最多 256 tab、并发 32 读盘)完成后才置位;`rootRestored`
在 root 恢复后、tab 读盘前置位(`hydrated ⇒ rootRestored`)。`waitForWorkspaceRootRestored()` 等
`rootRestored || hydrated`(subscribe 后再查一次,防丢事件)。

- `createUserTerminal`:tab 读盘在途时即以恢复出的 root 作 cwd/workspaceRoot 发起 `terminal.create`;
  root 恢复前仍等待(不以初始 null root 创建,R10 契约不变)。(`terminal-root-gate.spec.ts`)
- `MainApp` 向 main 推 window→root 映射:root 恢复前不推(R46 契约不变),`rootRestored` 后即推最新 root,
  不等 tab 读盘。(`notify-root-gate.spec.tsx`)

## 2 — 启动只读 IPC 并发:layout.read 预取 + explorer.read 提前发起

renderer `init()` 原先先 `await coApi.i18n.getLocale()`,之后才发 explorer.read;DockShell 的
`layout.read()` 更要等 React 首次提交 + dockview onReady(main 端读+解析+Zod explorer.json,在 Splash
放行关键路径上)。

- `init()` 在 `await getLocale` 之前发起 `layout.read` 预取(`shell/dock/layout-prefetch`;popout 子窗口不挂
  DockShell、无 windowSeq 段,不预取)与 `explorer.read`(由 `initExplorerPersistence` 的 `read()` 取用同一个
  promise,只取一次)。getLocale 仍在 `bootCorePlugins` / `createRoot` 之前 await,i18n 首次渲染前就绪契约不变。
  (`init-ipc-prefetch.spec.ts`)
- popout 子窗口(独立 BrowserWindow / 独立 JS 上下文,只渲染 PopoutHost,面板由父窗口经 portal 渲染)的
  `init()` 只做 i18n(getLocale + 广播订阅)与 `createRoot(App)`:不发 explorer.read、不跑 explorer 持久化
  (否则按沿用的 windowSeq hydrate 并注册写回)、不 bootCorePlugins、不建 PluginManager(不再二次 import/onload
  已启用插件)、不挂插件 MCP / fs-scope / debug / 协议桥。主窗口照旧。(`init-ipc-prefetch.spec.ts`)
- DockShell 首次 onReady 经 `readDockLayout()` 消费预取(不再发 IPC);之后的 onReady(StrictMode / dockview
  重建 / HMR 重挂)预取已被取走 → 重新读取,不复用旧结果。同步抛错统一转为 rejected promise,失败处理
  (默认布局 + 提示)与原 `await coApi.layout.read()` 一致。(`dock-layout-prefetch.spec.tsx`)
- 预取结果在首次 onReady 时仍有效:窗口段 layout 是 main-owned 字段,只有本窗口 DockShell 的 layout:write
  改它(explorer:write 合并保留 `cur.layout`,别窗只写自己段),而 DockShell 在消费预取完成恢复后才注册写入;
  layout:read 无参数,windowSeq 由 main 按 sender 解析(窗口创建即登记),读端守卫 `sanitizeReadLayout` 照常生效。
