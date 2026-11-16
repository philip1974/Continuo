# IpcPermissionStore(磁盘 backed 权限存储)

行为契约:**`IpcPermissionStore` 替代 `InMemoryPermissionStore`,把 grant/deny 决策写到
`userData/plugins/_permissions.json`。首次访问触发 readPermissions 拉远端到 in-memory cache;cache 之后
get 不走 IPC。grant/deny/clearDenied 只经 `coApi.plugins.mutatePluginPermissions` 发**增量变更**,
main 合并当前落盘记录后返回合并结果,store 以它更新该插件缓存(终审 P1,跨窗口见 `plugin-permission-cross-window`)。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/permissions/IpcPermissionStore.ts` | 实现 |
| `src/plugins/permissions.ts` | PermissionStore interface |

## 关键行为

### get(pluginId)

- 首次:`coApi.plugins.readPermissions()` → 写 cache
- 已有 cache:直接读
- pluginId 没决策 → []
- IPC ok=false / reject → 抛,不缓存(下次重试);未知态下 grant/deny 不写

### grant(pluginId, perms) / deny(pluginId, perms)

- 发 `{ kind: 'set', perms, granted }`,不发整条记录
- cache 采用 main 返回的合并记录(同 perm 反向决策被替换、不堆叠重复项)
- 空 perms → noop(不读不写)
- IPC 写失败 → 抛,cache 不变

### clearDenied(pluginId)

- 缓存中有拒绝项 → 发 `{ kind: 'clear-denied' }`,cache 采用合并结果(全被删 → 删 entry)
- 无拒绝项 / pluginId 不存在 → noop(不 IPC)

### 并发

- loading 期间并发 get 共享同一个 loadingPromise
- 同 plugin 的变更 per-plugin 串行,链排空后回收
