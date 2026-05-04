# plugin-permissions(声明式权限 + 授权门)

行为契约:**插件 manifest 可声明 `permissions: ['fs','network','shell','clipboard']`,
首次启用时由用户授权;授权决策记入 PermissionStore(InMemory 默认,生产 IPC 持久化)。**
PluginManager 在激活前调 `ensureAuthorized` 阻塞,未授权 / 用户拒 → 不激活。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/permissions.ts` | PermissionKey / PermissionStore / ensureAuthorized 算法 |
| `src/plugins/manifest.ts`(扩展) | manifest schema 增 `permissions` 字段 |

## 关键行为

### PermissionKey

```ts
type PermissionKey = 'fs' | 'network' | 'shell' | 'clipboard';
```

固定枚举(避免插件随便发明权限名)。manifest 缺省 / 空数组 → 视为无权限请求。

### Manifest schema 扩展

- `permissions?: PermissionKey[]`,运行时 zod 校验值在枚举内
- 不在枚举内 → SCHEMA_ERROR

### PermissionStore

```ts
interface PermissionStore {
  get(pluginId: string): Promise<PermissionDecision[]>;       // 已记录的授权
  grant(pluginId: string, perms: PermissionKey[]): Promise<void>;
  deny(pluginId: string, perms: PermissionKey[]): Promise<void>;
}

interface PermissionDecision {
  permission: PermissionKey;
  granted: boolean;       // true=已授;false=已拒
  decidedAt: number;
}
```

InMemoryPermissionStore 默认实现,Map<pluginId, decisions>。

### ensureAuthorized(pluginId, requested, store, prompt)

签名:
```ts
ensureAuthorized(
  pluginId: string,
  requested: readonly PermissionKey[],
  store: PermissionStore,
  prompt: (pid: string, perms: PermissionKey[]) => Promise<PermissionKey[]>,
): Promise<{ ok: true } | { ok: false; deniedPerms: PermissionKey[] }>;
```

算法:
1. 若 requested 空 → 直接 `{ ok:true }`
2. 读 store 当前决策,把 requested 拆为 `{已授, 已拒, 待决}`
3. 已拒任一 → `{ ok:false, deniedPerms: 已拒列表 }`(不再 prompt 复授)
4. 待决非空 → 调 `prompt(pluginId, 待决)`,得用户授权列表
5. 把待决里没在用户授权列表中的视为新拒,store.deny
6. 用户授权的 store.grant
7. 重新检查所有 requested 是否全 granted → ok 或 fail
