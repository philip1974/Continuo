# PluginsTabContent(插件 SettingTab 主体)

行为契约:**三段视图:贡献点统计(实时聚合 panels/commands/statusBar/ribbon/settingTabs/decorators/editorActions)
+ 内置插件清单(CORE_PLUGINS 静态)+ 第三方插件清单(从 PluginManager.listAll()
轮询 + Git URL 安装表单)。每条第三方:重载 / 启用-禁用 / 权限编辑(manifest.permissions 非空)/ 卸载。
卸载走 ConfirmDialog;权限走 PermissionEditorModal。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/PluginsTabContent.tsx` | UI |
| `src/plugins/PluginManager.ts` | getUserPluginManager / setUserPluginManager singleton getters |
| `src/plugins/permissions/co-permission-store.ts` | getUserPermissionStore getter |
| `src/plugins/registries/*` | 6 类 registry(贡献点统计) |

## 关键行为

### 贡献点统计

- 渲染 7 行:Panel/命令/StatusBar/Ribbon/设置 Tab/Explorer 装饰器/Editor Action
- 每行 label + count + samples(用 ' · ' 拼接,空 → '—')
- 任一 registry change → 重新计算

### 内置插件清单

- 4 条静态:core.editor / core.terminal / core.output / core.plugins

### 第三方插件清单

- getUserPluginManager()=null → 视为空
- listAll()=[] + 无 pendingInstall → 「暂无第三方插件」
- pendingInstall 存在 → 显示 ⏳ 行 + 待重启提示
- plugin status='enabled' → 显「禁用」按钮
- plugin status='disabled' → 显「启用」(primary)
- plugin status='failed' → 显「启用」(primary,重试)
- manifest.permissions 非空 + permStore 存在 → 显「权限」按钮
- error / warning 文案显示

### Git URL 安装

- 输入空 + 按钮 disabled
- 安装中 → 文案变「安装中…」+ disabled + Input disabled
- ok=true → installMsg=「✔ 已安装 …」+ pendingInstall 设入 + gitUrl 清空
- ok=false → installMsg=「✘ [code] message」
- 抛 → installMsg=「✘ ${err}」

### 操作按钮

- 重载 → mgr.reload(p.id) + refresh
- 禁用 → mgr.disable(p.id)
- 启用 → mgr.enable(p.id)
- 卸载 → 弹 ConfirmDialog,确认 → mgr.uninstall + refresh

### 权限按钮

- 点权限 → 设 permEditTarget,弹 PermissionEditorModal
- 关 → 清 permEditTarget
