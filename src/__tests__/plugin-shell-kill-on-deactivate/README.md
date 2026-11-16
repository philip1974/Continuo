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

### renderer

- `createScopedApp` 的 `shell.exec` / `shell.execStream` 请求自动带上本插件 id。
- `PluginManager` 在插件实例离开运行态时(disable / uninstall / 远端卸载 `handleUninstalled` / reload /
  shutdown,统一在 `deactivateEntry`)调用 `host.killPluginShellProcesses(id)`;失败只记录,不阻断停用。
- `createWindowApiHost().killPluginShellProcesses` → `coApi.shell.killPluginProcesses(id)`,`ok:false` 抛。

## 规范文件

- `main-kill.spec.ts`:真实子进程(仅 POSIX);exec 与流式两条路径;只终止匹配 (窗口, 插件) 的进程;不受信 frame 拒绝。
- `renderer-deactivate.spec.ts`:PluginManager 各停用路径调用终止;scoped app 带 pluginId;host 接线。
