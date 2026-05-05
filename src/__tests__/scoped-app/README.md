# scoped-app(per-plugin LMApp 包装)

行为契约:**`createScopedApp(lmApp, pluginId, store)` 返回每个 plugin 一份的
`LMPluginApp`,贡献点 registry 透传 lmApp 引用,fs/network/clipboard/
permission 是持 pluginId 的闭包。permission.check / granted 真读 store。**

> v5 Phase 1。fs/network/clipboard 当前直接转发 window.api / globalThis.fetch /
> navigator.clipboard,**未做权限检**;runtime gating 在 Phase 3 接入。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/scoped-app.ts` | createScopedApp + 5 个命名空间默认实现 |
| `src/plugins/types.ts`(扩展) | LMPluginApp / PluginFsApi / PluginNetworkApi / PluginClipboardApi / PluginPermissionApi / PluginShellApi |
| `src/plugins/permissions.ts`(扩展) | PermissionError class |

## 关键行为

### createScopedApp(lmApp, pluginId, store)

- 返回新对象,所有 lmApp 字段(panels/commands/...)用 spread 透传引用
- fs / network / clipboard / shell / permission 5 个新字段是新构造,持 pluginId
- 不复制 registry,**两个 plugin 的 scopedApp.commands 是同一引用**

### permission.check(perm) / granted()

- store 为 null → check 一律返 true,granted 返 []
- store 非 null → 调 `store.get(pluginId)`,过滤 granted=true 的判定
- 异步(对齐 PermissionStore 接口)

### fs / network / clipboard(Phase 1 实现)

- 直接转发 window.api.fs / globalThis.fetch / navigator.clipboard
- IpcResult 拆包:ok=false 抛 Error 含 code 与 message
- jsdom 环境 window.api.fs 不存在 → 抛"未注入"

### shell

- Phase 1 占位,空对象;接口稳定但无方法
- Phase 3 实装

### PermissionError

- `code = 'PERMISSION_DENIED'`(常量字面)
- `permission: PermissionKey` 暴露被拒的具体权限
- 默认 message `权限 X 未授权`,可覆盖
