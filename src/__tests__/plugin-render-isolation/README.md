# plugin-render-isolation — 插件贡献渲染出错只影响它自己,不拖垮主窗

## 背景 / 缺陷

插件贡献的界面(状态栏项 `render()`、面板 `factory`、设置页 `render()`、各处 `icon` ReactNode)在宿主的 React
树里渲染。全仓此前只有编辑引擎一个局部错误边界:任一插件组件渲染抛错一路冒泡到根,**整个主窗白屏**;状态栏项每次
启动都渲染 → 每次启动都白屏,界面里无从禁用该插件。状态栏 `try/catch` 只接得住 `render()` 本身的同步抛错,接不住它
返回的组件在 React 渲染期抛的错。

## 对齐 VSCode

扩展出错不拖垮工作台:只有出错的视图显示错误,其余照常;并以通知告知「哪个扩展出了问题」。

## 行为契约

- 通用 `PluginRenderBoundary`(`src/plugins/PluginRenderBoundary.tsx`)包住每个第三方贡献的渲染点:
  - 面板 factory(`shell/dock/panel-components.tsx`)、设置页 `render()` 与导航图标(`plugins/settings/SettingsPanel.tsx`)
    —— **块级**回退:`role="alert"`,文案「插件「X」渲染出错」,带「禁用插件」「重载」按钮(分别调 manager.disable / reload)。
  - 状态栏项 `render()`(`shell/StatusBar.tsx`)、功能区图标(`shell/IconSidebar.tsx`)、编辑器操作图标
    (`panels/Editor/EditorHeader.tsx`)、资源管理器右键菜单图标(`panels/Explorer/ContextMenu.tsx`)、资源管理器装饰图标
    (`panels/Explorer/FileRow.tsx`)、设置页导航图标 —— **紧凑**回退:一个警示图标,`title` / `aria-label` 为「插件「X」渲染出错」。
  - 命令面板 / 快捷键 / 设置项 / 插件通知只渲染插件给的**字符串**(注册表校验),不是 React 渲染点。
- 出错时:错误不再冒泡到根(主窗其余部分照常可用);按贡献的所有者(scoped app 登记的 `plugin:<id>`)调
  `PluginManager.markRenderFailed(id, err)` —— 插件标为 `failed`(error code `RENDER_FAILED`),实例保留;
  通知由 `plugin-failure-notify/` 的统一出口按插件去重发一次。
- 所有者不明(无登记)的贡献按第三方处理(回退文案不带插件名、无操作按钮);内置插件(`core:`)贡献不包边界。
- 同一贡献换新 spec(重载 / 重新启用后重新注册)→ 边界复位重新渲染。
- `PluginManager`:`markRenderFailed` 只作用于 `enabled` 的插件(已 failed 不重复);之后启用(重试)先停用仍在运行的旧实例
  再激活,不出现双实例。
- 渲染出错**不改变启用状态**(对齐 VSCode):启用(插件页「启用」、禁用占位「启用」、市场安装后启用、别的窗口启用广播)
  以「激活成功(有运行中的实例)」为准记启用意图并写 `_enabled.json`,不看瞬时 `status` —— 激活一完成贡献就渲染,
  渲染出错可能在启用的 await 期间就把状态改成 `failed`。之后错误块「重载」按启用意图重新激活(仍启用),重启后仍启用。
- 错误块「禁用插件」/「重载」完成后错误块被替换,焦点不掉到 body(对齐 VSCode:操作后焦点落在替换出的内容):
  面板 → `focusPanelContent`(禁用后是占位的「启用」按钮,重载成功后是面板内容);设置页 → 当前选中的导航项
  (`aria-current="page"`)。焦点已被用户移到别处则不抢。
