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
  clearDenied(pluginId: string): Promise<void>;               // 清掉 granted=false,允许重 prompt
}

interface PermissionDecision {
  permission: PermissionKey;
  granted: boolean;       // true=已授;false=已拒
  decidedAt: number;
}
```

InMemoryPermissionStore 默认实现,Map<pluginId, decisions>。

### clearDenied 重试机制(v4.7)

`已 deny 任一 → 立即 fail` 这条决策让 ensureAuthorized 不会自动复弹 Modal。
但用户可能改主意,UI 提供 [启用] 按钮时:`PluginManager.enable(failedId)` 会先调
`store.clearDenied(id)` 清掉 granted=false 的决策(保留 granted=true),再走
activate → ensureAuthorized,这时 deny 已清,会重新 prompt 用户。

### ensureAuthorized(pluginId, requested, store, prompt)

签名(v5 Phase 2 改 partial-grant 语义):
```ts
ensureAuthorized(
  pluginId: string,
  requested: readonly PermissionKey[],
  store: PermissionStore,
  prompt: (pid: string, perms: PermissionKey[]) => Promise<PermissionKey[]>,
): Promise<
  | { ok: true; granted: PermissionKey[]; denied: PermissionKey[] }
  | { ok: false; deniedPerms: PermissionKey[] }
>;
```

算法:
1. 若 requested 空 → `{ ok:true, granted:[], denied:[] }`
2. 读 store 当前决策,拆 requested 为 `{已授, 已拒, 待决}`
3. 待决非空 → 调 `prompt(pluginId, 待决)`,得用户授权列表
4. 把用户授权的 store.grant,未授的视为新拒 store.deny;已 deny 不复 prompt
5. 计算 final granted / denied 子集
6. 全拒(granted=[]) → `{ ok:false, deniedPerms }`(plugin 不激活,触发 v4.7 retry 路径)
7. 否则 → `{ ok:true, granted, denied }`,**partial(denied≠[])时 plugin 仍激活**,
   调用方据 denied.length>0 设 entry.warning
