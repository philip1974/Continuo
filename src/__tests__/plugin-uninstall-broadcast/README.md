# plugin-uninstall-broadcast(跨窗口卸载撤销插件实例与授权)

终审 P1:每个窗口各有一个 `PluginManager` + `IpcPermissionStore`(内存授权缓存)。此前窗口 A 卸载插件只在 A
本地停用 / 删 entry;窗口 B 的插件实例、贡献点、授权缓存继续存活,仍可调用 shell / network / clipboard。
main 的 mtime watcher 只发现 `main.js` 变化,发现不了目录删除,B 无从得知。

## 行为契约

### main(`electron/main/ipc/plugins.ipc.ts`)

- `plugins:uninstall` 成功后,经 `broadcastToWindows` 向所有窗口推 `plugins:uninstalled { id }`(含发起卸载的窗口)。
- 跳过已销毁窗口;某窗口 `send` 抛错只记录,不影响其它窗口与卸载结果。
- 卸载失败 → 不广播(插件仍在盘上,各窗口照常运行)。

### renderer

- preload `plugins.onUninstalled(cb)`:payload 复用 `isPluginsChangedPayload` 守卫,畸形 warn + drop。
- `wirePluginReloadGate` 订阅该广播并交给 `PluginManager.handleUninstalled(id)`;init 完成前到达的先缓冲,
  init 完成后再处理(init 可能已用卸载前的目录快照激活了该插件)。
- `handleUninstalled(id)`:与本地卸载相同的停用(贡献点随 `_deactivate` 注销)/ 回收 plugin-fs token /
  移除 entry,并调用 `permissionStore.forget(id)` 失效授权缓存 → `permission.check` 等不再放行。
  **不触盘**(不写 `_enabled.json`、不删目录:main 已处理)。
- 幂等:发起卸载的窗口自身也收到广播,entry 已不在 → 只清权限缓存,不抛、不重复停用。
- **卸载后不得授权 / 执行已删除插件**(终审 P1):广播到达时**立即**(不等生命周期锁;reload-gate 在 init 完成前
  也立即调用)执行 `PluginManager.markUninstalled(id)`:标记已卸载、经 `host.cancelPermissionPrompt` 取消该插件
  待决的授权弹窗(当前显示的 + 排队中的,以 `NOT_INSTALLED` reject —— 不 resolve `[]`,否则被当作「用户全拒」写盘)、
  失效授权缓存。在途激活在权限门前、`import` 插件模块前、构造实例前检查该标记,已卸载 → 以 `NOT_INSTALLED` 中止,
  插件代码不执行、授权不写入。随后再排队执行上面的锁内卸载清理。
- 当前弹窗被取消后队列里下一个插件的弹窗接着显示;其它插件的弹窗不受影响。
- `IpcPermissionStore.forget(id)`:删除缓存条目;权限缓存加载在途时,加载结果落 cache 前同样剔除该插件
  (读到的可能是卸载前的快照)。

## 规范文件

- `main-broadcast.spec.ts`:main 侧广播(含跳过已销毁窗口、send 抛错隔离、失败不广播)。
- `pending-prompt-cancel.spec.ts`:弹窗挂起时收到广播 → 弹窗取消、插件代码未执行、权限未写入;授权写入在途时收到
  广播 → 不加载插件代码;排队弹窗取消与队列推进;init 激活挂在弹窗上时 gate 立即标记并取消。
- `renderer-teardown.spec.ts`:两个 manager 模拟窗口 A / B;B 收到广播后实例停用、贡献点注销、权限查询不再放行;
  发起窗口幂等;forget 与加载在途;reload-gate 接线与 init 前缓冲。
