# plugin-settings-section(插件自定义 category 的设置项)

对齐 VSCode 设置编辑器的「扩展」节点:扩展贡献的配置自动出现在「扩展 › <扩展名>」下,而不是只能搜到。

## 行为

- 插件用内置之外的 category(`addSettingItem({ category: 'acme', … })`)注册的设置项,出现在内置「插件设置」页签
 (`core.plugin-settings`,三语 Plugin Settings / 插件设置 / 플러그인 설정,排在快捷键之后)里。
- 该页签只在存在这类设置项时出现;插件禁用 / 卸载(设置项随之注销)后,对应节消失,没有剩余项时页签消失。
- 页签内按插件分节,节标题是插件 manifest `name`(插件列表里查不到时退回插件 id);宿主直接注册、没有所有者记录的
  项按 category 原文分节。节内仍按 `group` / `groupKey` 分组。
- 内置 category(general / editor / explorer / terminal)的设置项照旧只在各自页签里,不进「插件设置」。
- 搜索结果的分组标题同样用可读名:内置 category 用页签名,插件 category 用插件名。
- 插件热重载(停用 → 重新激活)期间页签按钮卸载重挂时,焦点若停在该页签按钮上:
  - 页签重新出现 → 焦点交回该页签按钮;
  - 页签暂时 / 永久消失 → 焦点先回落到设置导航当前选中项;页签之后重新出现且焦点仍停在回落位置时再交回。
  - 焦点已被移到别处(用户点了别的控件)时不抢。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/plugin-setting-sections.ts` | 内置 category 表、是否插件 category、设置项所属节(key + 可读名) |
| `src/core-plugins/PluginSettingsTabPlugin.ts` | 按需注册 / 注销「插件设置」页签 |
| `src/plugins/settings/CategoryTabContent.tsx` | `PluginSettingsTabContent`:按插件分节渲染 |
| `src/plugins/settings/SettingsPanel.tsx` | 搜索分组标题;热重载后焦点交回页签按钮 |
