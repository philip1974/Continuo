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
- 写入顺序:先 deny 后 grant(中途失败只会少授不会多授);deny 写失败 → 不再 grant,
  持久化保持原状态;deny 成功而 grant 写失败 → 把已 deny 的原 granted 项重新 grant
  (尽力回滚),Modal 保持打开并显示失败提示

### 取消

- 调 onClose,不写盘

### 父组件重渲

- 打开期间父组件重渲换新 onClose 引用 → Modal 焦点/键盘 effect 不重跑(焦点留在用户所在控件),Esc 调最新 onClose
