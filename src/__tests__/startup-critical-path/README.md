# startup-critical-path(冷启动关键路径 · renderer)

把只依赖部分启动数据的步骤从更长的等待链上拆下来,行为保持。

## 1 — 只依赖 root 的消费方等 `rootRestored`,不等编辑器 tab 读盘

`rootRestored` 在 root 恢复后、`hydrateEditorTabs`(最多 256 tab、并发 32 读盘)之前置位。
`waitForWorkspaceRootRestored()` 等 `rootRestored`(subscribe 后再查一次,防丢事件)。(原 `workspace.hydrated`
在 tab 读盘后置位,无消费方,已删除。)

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
  `init()` 只做 i18n(getLocale + 广播订阅)、PROD 下的 `sandboxSweep()`(插件面板 portal 进本窗,同口径清洗)与 `createRoot(App)`:不发 explorer.read、不跑 explorer 持久化
  (否则按沿用的 windowSeq hydrate 并注册写回)、不 bootCorePlugins、不建 PluginManager(不再二次 import/onload
  已启用插件)、不挂插件 MCP / fs-scope / debug / 协议桥。主窗口照旧。(`init-ipc-prefetch.spec.ts`)
- DockShell 首次 onReady 经 `readDockLayout()` 消费预取(不再发 IPC);之后的 onReady(StrictMode / dockview
  重建 / HMR 重挂)预取已被取走 → 重新读取,不复用旧结果。同步抛错统一转为 rejected promise,失败处理
  (默认布局 + 提示)与原 `await coApi.layout.read()` 一致。(`dock-layout-prefetch.spec.tsx`)
- 预取结果在首次 onReady 时仍有效:窗口段 layout 是 main-owned 字段,只有本窗口 DockShell 的 layout:write
  改它(explorer:write 合并保留 `cur.layout`,别窗只写自己段),而 DockShell 在消费预取完成恢复后才注册写入;
  layout:read 无参数,windowSeq 由 main 按 sender 解析(窗口创建即登记),读端守卫 `sanitizeReadLayout` 照常生效。

## 3 — 启动插件源码有界并发预取(激活仍串行)

`PluginManager.init` 两阶段(登记全部 entry → 逐个串行激活)之间,对 `status==='enabled'` 的 entry 以并发 4
调 `host.prefetchModule(moduleUrl)`:renderer host 只按目录名 `readMainByDir`(带列举快照 manifest 令牌)拉源码
并生成 Blob URL,**不 import、不执行插件代码**(故可在权限门之前)。串行激活的 `importModule` 命中预取结果或
加入同一引用的在途拉取(单飞),激活顺序不变,不并发激活。(`plugin-source-prefetch.spec.ts`)

- 第一个插件 onload 挂起时,其余已启用插件的源码读取已发出;每个插件源码只读一次。
- 禁用插件不预取;轮到预取时已禁用 / 卸载 / 换了 dirInfo 的不再预取。
- 预取失败不缓存:激活时照原路径重拉(加入的在途预取失败也重拉一次)。
- 令牌:预取结果只挂在其源码引用上,引用与列举快照的 (目录, manifestHash) 一一绑定;热重载换了 manifest →
  新 dirInfo / 新引用,不复用旧预取。
- 未被 import 的预取结果在该 entry 的 init 激活回合结束后 `releasePrefetchedModule` 释放(revoke Blob URL;
  在途读取完成时作废并立即 revoke),Blob URL 不泄漏。
- 语义说明:预取后、激活前磁盘上 manifest 被改 → 激活执行的是预取时与快照令牌一致的那一对(旧 manifest + 旧
  main,一致),随后 watcher 热重载;不会以旧 manifest 执行新 main。
