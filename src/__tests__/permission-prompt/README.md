# permission-prompt(授权 UI store + Modal + Manager 集成)

行为契约:**Plugin 激活前若有 permissions 请求,弹 design Modal 让用户勾选授予哪些权限**;
PromptFn 桥接到 store,Promise 形态返回。PluginManager 在 _activate 前调
`ensureAuthorized`,被拒 → 标 failed + 原因,不调 onload。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/permissions/promptStore.ts` | usePermissionPromptStore + request/grant/denyAll |
| `src/plugins/permissions/PermissionPrompt.tsx` | Modal UI |
| `src/plugins/PluginManager.ts`(扩展) | 接受 permissionStore + promptFn,activateEntry 前调 ensureAuthorized |

## 关键行为

### promptStore.request(pluginId, perms): Promise<PermissionKey[]>

- 设 pending = { pluginId, perms } + 内部存 resolve
- 同时只能一个 pending(再 request 直接 resolve [] 拒)
- grant(perms) → resolve(perms) + 清 pending
- denyAll() → resolve([])
- close 等同 denyAll(用户关 Modal 视为拒绝)

### PermissionPrompt UI

- Modal,visible = pending !== null
- 标题 "插件 <id> 请求权限"
- 每个 perm 一行 + checkbox
- "全选" / "全部拒绝" / "确认授权选中" 三个按钮
- ESC / 遮罩点 → denyAll

### PluginManager 集成

- ManagerHost 增 optional `permissionStore` + `promptFn`
- activateEntry 流程:
  1. loadPluginModule(成功)
  2. **若 manifest.permissions 非空且 host 配 permissionStore + promptFn → 调 ensureAuthorized**
  3. 失败 → entry.status='failed', error='PERMISSION_DENIED: <list>',不 new instance
  4. 成功(或无 permissions / 无 host)→ new + _activate 原流程
- 缺 host 字段时:权限请求不被检查(向后兼容,测试用)
