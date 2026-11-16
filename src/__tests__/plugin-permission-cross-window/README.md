# plugin-permission-cross-window(插件授权跨窗口一致)

终审 P1:每个窗口各有一个 `IpcPermissionStore`(内存授权缓存)。此前:

1. 窗口 A 撤销某插件的 shell 并保存,窗口 B 的缓存不知情 → B 禁用再启用 / `permission.check` 仍认为 shell 已授。
2. B 保存其它权限时,renderer 把**整条**(基于陈旧缓存算出的)记录发给 main 覆盖写 → A 的拒绝被写回成授权。

## 行为契约

### main(`electron/main/services/plugins.service.ts` / `electron/main/ipc/plugins.ipc.ts`)

- `mutatePluginPermissions(baseDir, id, mutation)`:在 `_permissions.json` 的全局串行写链内,读**当前落盘**记录,
  按权限项合并:
  - `{ kind: 'set', perms, granted }`:只替换 `perms` 中各项的决策(`decidedAt` 由 main 取当前时间),
    其它权限项与 `pathScopes` 原样保留。
  - `{ kind: 'clear-denied' }`:去掉所有 `granted=false` 项,保留已授项与 `pathScopes`;
    合并后既无决策也无 `pathScopes` → 删除该 id 条目。
  - 返回合并后的记录(条目被删 → `null`),renderer 以它作为该插件的权威缓存。
  - 插件目录不存在(已卸载 / 未安装)→ 抛 `NOT_INSTALLED`、不写盘(终审 P1:别的窗口在卸载后点旧授权弹窗的
    「授权」不得把授权写回,同 id 重装会继承)。整段纳入同 id mutation 锁,与 `uninstallPlugin` 互斥。
- IPC `plugins:mutate-plugin-permissions { id, mutation }` 取代旧的整条覆盖写 `plugins:write-plugin-permissions`
  (renderer 不再发整条记录)。成功后经 `broadcastToWindows` 向所有窗口(含发起者)推
  `plugins:permissions-changed { id }`;失败不广播。

### renderer

- `IpcPermissionStore.grant/deny/clearDenied` 改发增量变更,用 main 返回的合并结果更新缓存。
- `IpcPermissionStore.invalidate(id)`:丢弃缓存,下次读重新从 main 加载;加载在途时其结果不再落缓存
  (读到的可能是变更前的快照)。
- 启动接线:`coApi.plugins.onPermissionsChanged(id => store.invalidate(id))`(preload 复用 `{ id }` payload 守卫)。

## 规范文件

- `main-merge.spec.ts`:真实临时目录;陈旧窗口的增量保存不覆盖别窗的撤销;clear-denied 语义;保留 pathScopes;已卸载插件拒绝写入。
- `main-broadcast.spec.ts`:IPC 成功后广播、失败不广播、返回合并记录、输入 schema 上限。
- `renderer-invalidate.spec.ts`:两个 store 模拟窗口 A / B;A 撤销后 B 的 `permission.check` 变 false;
  B 保存其它权限不会把 A 的撤销覆盖回来;加载在途被失效。
