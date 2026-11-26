# PluginsTabContent(插件 SettingTab 主体)

行为契约:**三段视图:贡献点统计(实时聚合 panels/commands/statusBar/ribbon/settingTabs/settingItems/decorators/explorerContextMenu/editorActions)
+ 内置插件清单(CORE_PLUGINS 静态)+ 第三方插件清单(从 PluginManager.listAll()
订阅 PluginManager 的列表变化 + Git URL 安装表单)。每条第三方:重载 / 启用-禁用 / 权限编辑(manifest.permissions 非空)/ 卸载。
卸载走 ConfirmDialog;权限走 PermissionEditorModal。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/PluginsTabContent.tsx` | UI |
| `src/plugins/PluginManager.ts` | getUserPluginManager / setUserPluginManager singleton getters |
| `src/plugins/permissions/co-permission-store.ts` | getUserPermissionStore getter |
| `src/plugins/registries/*` | 9 类 registry(贡献点统计) |

## 关键行为

### 贡献点统计

- 渲染 9 行:Panel/命令/StatusBar/Ribbon/设置 Tab/设置项/Explorer 装饰器/Explorer 右键菜单/Editor Action
  (设置项与右键菜单同其它行口径:注册表全部条目计数,示例为 id)
- 每行 label + count + samples(用 ' · ' 拼接,空 → '—')
- 任一 registry change → 重新计算

### 内置插件清单

- 4 条静态:core.editor / core.terminal / core.output / core.plugins;名称与描述走 catalog(三语,zh 显示编辑器 / 终端 / 输出 / 插件管理),第三方插件仍显示 manifest 名

### 第三方插件清单

- getUserPluginManager()=null → 视为空
- listAll()=[] + 无 pendingInstall → 「暂无第三方插件」+「浏览插件市场」按钮(切到 `core.marketplace` 设置页签,焦点交给导航里的市场页签)
- 区块顺序:用户插件 → 贡献点统计 → 内置插件清单(用户要管理的是自己装的插件,同 VSCode 扩展视图「已安装」在最上;自检信息次之)
- pendingInstall 存在 → 显示 ⏳ 行 + 待重启提示 +「立即重启」(见 `plugin-install-enable/`);连续安装多个 → 每个一行;
  id 已出现在插件列表(已加载 / 覆盖重装)→ 不再显示待重启行
- plugin status='enabled' → 显「禁用」按钮
- plugin status='disabled' → 显「启用」(primary)
- plugin status='failed' → 显「启用」(primary,重试)+「禁用」
- 「启用 / 禁用」是同一个按钮(固定槽位,只换文字 / 动作 / 样式):点后状态切换,焦点仍在该按钮上(对齐 VSCode 扩展页),
  不掉到 body;failed 行的「启用」重试成功后随状态消失 → 焦点交给同一行的切换按钮。焦点已被用户移到别处则不抢
- manifest.permissions 非空 + permStore 存在 → 显「权限」按钮
- error / warning 文案显示

### Git URL 安装

- 输入空 + 按钮 disabled
- 安装中 → 文案变「安装中…」+ disabled + Input disabled
- ok=true → installMsg=「✔ 已安装 …」+ 记入会话级待重启 store(跨页共享,见 `pending-installs-store/`)+ gitUrl 清空
- ok=false → installMsg=本地化原因(不带内部错误码 `[CODE]`;`BAD_URL` 附「仅支持 https:// 仓库地址」指引)
- EEXIST(插件已在盘上,main 带回仓库 manifest 的 id / name / version)——对齐 VSCode「对已安装扩展再次安装 = 覆盖 / 更新」:
  - 该 id 已在本窗口列表、版本不同 → ConfirmDialog「「{name}」已安装 v{旧},覆盖并更新到 v{新}?」;确认 → `installFromGit(url, true)`
    覆盖(watcher 热重载,新增权限照常走授权确认),提示「已更新 …」并清空输入;取消 → 什么都不做
  - 已在列表且同版本 → 提示「「{name}」已是最新版本 v{版本}」(非错误,不弹确认)
  - 不在列表(其它窗口装的)→「{插件名} 已安装 — 若尚未出现在插件列表中…重启后加载」(用插件名而非仓库名)
- 抛 → installMsg=「✘ ${err}」

### 操作按钮

- 重载 → mgr.reload(p.id)(列表经 useUserPluginList 订阅 PluginManager 自动更新)
- 禁用 → mgr.disable(p.id)
- 启用 → mgr.enable(p.id)
- 卸载 → 弹 ConfirmDialog,确认 → mgr.uninstall

### 权限按钮

- 点权限 → 设 permEditTarget,弹 PermissionEditorModal
- 关 → 清 permEditTarget
