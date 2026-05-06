# plugin-mcp-permission (Plugin → MCP Bridge · 权限门)

行为契约:**新 PermissionKey `mcp-tools` 的声明 + scoped-app gating**。

- manifest 可声明 `permissions: ['mcp-tools']`
- 未声明 / 已 deny → `app.mcp.register(spec)` 抛 `PermissionError('mcp-tools')`
- granted → `app.mcp.register` 透传到底层 PluginMcpRegistry,行为等同 registry topic

> 配套:[doc/12-plugin-permissions.md](../../../doc/12-plugin-permissions.md) §权限键扩展

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/permissions.ts` | `PermissionKey` 类型加 `'mcp-tools'`;`PERMISSION_KEYS` 列表加此项 |
| `src/plugins/manifest.ts` | manifest schema 的 `permissions` zod enum 加 `'mcp-tools'` |
| `src/plugins/scoped-app.ts` | 加 `mcp` 字段;`mcp.register` 内部 `ensurePerm(pluginId, 'mcp-tools', store)` |

需 export 的形态(供本主题断言):

```ts
// permissions.ts
export type PermissionKey = 'fs' | 'network' | 'shell' | 'clipboard' | 'mcp-tools';
export const PERMISSION_KEYS: readonly PermissionKey[] = [
  'fs', 'network', 'shell', 'clipboard', 'mcp-tools',
];

// types.ts
export interface PluginMcpApi {
  register(spec: PluginMcpToolSpec): Promise<Disposable>;
}
export interface CoApp { /* ...原有, */ readonly mcp: PluginMcpRegistry }
export interface CoPluginApp extends CoApp { /* ...原有, */ readonly mcp: PluginMcpApi }
//   注:CoApp.mcp 是单例 registry(全 renderer 共享);CoPluginApp.mcp 是
//   per-plugin scope wrapper,知道自己 pluginId,自动检权限。
```

## 关键行为

### PermissionKey 列表

- `PERMISSION_KEYS` 包含新增的 `'mcp-tools'`
- TypeScript 层:`PermissionKey` union 含 `'mcp-tools'`

### Manifest schema

- `parseManifest` 接受 `permissions: ['mcp-tools']` → ok
- `parseManifest` 接受 `permissions: ['fs', 'mcp-tools']`(混合)→ ok
- `parseManifest` 接受 `permissions: ['unknown-perm']` → fail(已有契约,本主题不重测)

### scoped-app · 未声明 mcp-tools

- 任何 plugin 调 `app.mcp.register(spec)`,store 中无 `mcp-tools` granted=true 决策
  → reject `PermissionError`,`err.permission === 'mcp-tools'`,`err.code === 'PERMISSION_DENIED'`
- 不调底层 registry.register(避免发垃圾 IPC)

### scoped-app · 已 grant mcp-tools

- store 有 `mcp-tools` granted=true → `app.mcp.register(spec)` 透传调底层 registry.register
- 返回的 Disposable 与底层 registry 的相同(透传)

### scoped-app · 已 deny mcp-tools

- store 有 `mcp-tools` granted=false → reject `PermissionError`(同未声明路径)

### scoped-app · store=null(测试 / 向后兼容)

- 沿用现有 fs/network/clipboard 默认路径:store=null 跳过 gating,直接透传调底层 registry
- 即未传 store 时本主题不强制权限门(同 scoped-app spec §"store=null 跳过 gating")

### per-plugin 隔离

- p.a 授了 `mcp-tools`,p.b 未授 → p.b 的 register 抛 PermissionError,p.a 不受影响
- 与 fs / network 的隔离断言形态一致

### Disposable 在底层 registry 抛错时的传染

- 底层 registry 抛 `TOOL_NAME_TAKEN` → scoped wrapper reject 同(透传)
- 不是 PermissionError(因权限已通过)— 区分两种失败

### CoPluginApp.mcp ≠ CoApp.mcp(per-plugin 闭包)

- 两个 plugin 的 scoped app 的 `mcp` 是不同对象(各自闭包持自己的 pluginId)
- 但底下指向同一 PluginMcpRegistry 实例(单 renderer 一份)

## 不在本主题验证

- 权限决策持久化(由 `plugin-permissions` topic 持有)
- `ensureAuthorized` 流程(由 `plugin-permissions` topic 持有)
- 底层 registry 的 register 行为(由 `plugin-mcp-registry` topic 持有)
- `app.mcp.register` 走过权限门后实际 IPC 上行(由 `plugin-mcp-stub-tool` / e2e 持有)
