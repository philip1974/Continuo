# plugin-shell-kill-on-deactivate(停用/卸载插件终止其 shell 进程)

终审 P1:`app.shell.exec` / `app.shell.execStream` 启动的子进程此前只按 webContents 归属(关窗/重载才清),
不按插件区分。插件停用 / 卸载后它的长任务继续跑到超时(exec 默认 30s、最长 30min;流式默认 5min)。

## 行为契约

### main

- `shell:exec` 输入可带 `pluginId`;`plugin-shell-stream:start` 的 opts 可带 `pluginId`。main 把子进程登记为
  (发送方 webContents id, pluginId) 所有(`electron/main/lib/plugin-shell-owners.ts`),子进程 close/error 后注销。
- 新 IPC `shell:kill-plugin-processes { pluginId }`:受信 frame 校验;只终止**发送方 webContents** 名下、
  该 `pluginId` 的进程树(`killProcessTreesNow`:整组 SIGTERM+SIGKILL,等待 close,有上限)。
  流式子进程被杀后照常走 close → exit 事件与 active 槽位回收;一次性 exec 的 Promise 照常结算。
- `pluginId` 由 renderer 自报,只用于「本窗口内按插件分组终止」,不作授权依据(只能终止本窗口自己的进程)。
- 一次性 `shell:exec` 在途子进程并发上限(终审 P1,E230 同族):与流式同款全局 128 + 单 sender 32 双闸,spawn 前
  拒绝(`TOO_MANY_STREAMS`,不 spawn、不起 timer);close / error 释放名额(只释放一次)。
  规范:`electron/main/__tests__/shell-exec-active-cap.test.ts`。
- 一次性 `shell:exec` 随所属窗口回收(终审 P1):IPC 入口为发送方 webContents 挂与流式同款的 wc-gone 钩子
  (`destroyed` + main frame 非同文档导航,即关窗 / 整页重载;in-page 导航不算),触发时 `killProcessTreesNow` 终止该
  sender 名下全部 exec 进程树,close 后释放名额;其它 sender 不受影响。
  规范:`electron/main/__tests__/shell-exec-wc-gone.test.ts`。

### renderer

- `createScopedApp` 的 `shell.exec` / `shell.execStream` 请求自动带上本插件 id。
- `PluginManager` 在插件实例离开运行态时(disable / uninstall / 远端卸载 `handleUninstalled` / reload /
  shutdown,统一在 `deactivateEntry`)调用 `host.killPluginShellProcesses(id)`;失败只记录,不阻断停用。
- 插件 `onunload` 挂起(永不返回)不阻塞停用:`Plugin._deactivate` 最多等 `PLUGIN_UNLOAD_TIMEOUT_MS`(5s),
  超时 warn 后继续 —— FS token 回收、shell 进程终止、禁用落盘照常执行。
- `onload` 挂起期间被禁用 / 卸载:`PluginManager.revokeImmediately` 锁外立即终止(见 plugin-capability-revoke 1b)。
- 激活失败(构造函数 / onload 抛错,可能已 exec / execStream 启动进程)同样调用 `host.killPluginShellProcesses(id)`
  (失败实例不进 activationOrder,之后的禁用 / 卸载 / shutdown 都清不到)。
- `createWindowApiHost().killPluginShellProcesses` → `coApi.shell.killPluginProcesses(id)`,`ok:false` 抛。

## 规范文件

- `main-kill.spec.ts`:真实子进程(仅 POSIX);exec 与流式两条路径;只终止匹配 (窗口, 插件) 的进程;不受信 frame 拒绝。
- `renderer-deactivate.spec.ts`:PluginManager 各停用路径调用终止(含 onunload 挂起超时、激活失败);scoped app 带 pluginId;host 接线。
