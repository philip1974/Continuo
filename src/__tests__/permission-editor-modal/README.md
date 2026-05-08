# PermissionEditorModal(M-Plugin v4.7 事后改主意)

行为契约:**用户可以从插件列表打开本 Modal 修改之前授权的决策。declared 列出 manifest
声明的权限,checkbox 由 store.get(pluginId) 拿到的 prior decision 初始化(granted=true 勾选,
denied=false / 未决=null 不勾选);点击切换状态;保存时把 granted=true 项 store.grant、
granted=false 项 store.deny,然后 onClose。当前已 enabled 实例不强制 disable,
等用户手动 [禁用]→[启用] 才生效。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/permissions/PermissionEditorModal.tsx` | UI |
| `src/plugins/permissions.ts` | PermissionStore 接口 |

## 关键行为

### 渲染条件

- `pluginId === null` → 不渲染(返 null)
- `pluginId` 提供 → 拉 store.get(pluginId) 初始化勾选

### 初始勾选

- prior granted=true → checked
- prior granted=false → not checked
- 没有 prior → not checked(null)

### toggle

- null/false → true
- true → false

### save

- granted=true 一组 → store.grant
- granted=false 一组 → store.deny
- 两组都为空 → 不调任何 IPC,直接 onClose
- 调完 onClose

### 取消

- 调 onClose,不写盘
