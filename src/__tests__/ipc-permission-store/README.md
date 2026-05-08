# IpcPermissionStore(磁盘 backed 权限存储)

行为契约:**`IpcPermissionStore` 替代 `InMemoryPermissionStore`,把 grant/deny 决策写到
`userData/plugins/_permissions.json`(经 coApi.plugins.writePermissions IPC)。
首次访问触发 readPermissions 拉远端到 in-memory cache;cache 之后 get 不走 IPC,
但每次 grant/deny/clearDenied 都把整个 cache 写盘。**

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
- IPC ok=false → cache 当成空 dict

### grant(pluginId, perms)

- 同 perm 之前若有反向决策(deny)→ 替换为 granted
- 多次 grant 不重复堆同 perm 项
- 整个 cache 写盘(包括其它 pluginId 的现存项)
- IPC 写盘失败 → console.warn,不抛(in-memory 仍变更)

### deny(pluginId, perms)

- 同 grant,但 granted=false

### clearDenied(pluginId)

- 删该 pluginId 下所有 granted=false 项,保留 granted=true
- 全部都是 denied → 删整个 entry
- pluginId 不存在 → noop(不 IPC)

### loading 期间并发 get

- 重复入参不重复 IPC,所有 caller 等同一 promise(loadingPromise 互斥)
