# 功能入口可发现性(对齐 VSCode 菜单 / 活动栏 / 命令面板 / 过滤菜单)

第 57 轮 B 组审计(功能可发现性视角):命令都已注册,但只能靠快捷键或命令面板找到 —— 菜单栏缺高频项、活动栏只有资源管理器与设置、
命令面板按 VSCode 说法搜不到设置 / 快捷键、帮助菜单只有两项且 Windows / Linux 看不到版本号、设置搜索的 `@modified` / `@id:` 无从
得知、状态栏「侧栏已隐藏」不可点。参考 VSCode 源码(`MenuRegistry.appendMenuItem` 各 `MenuId.MenubarXxxMenu` 贡献,中文 / 韩文标签取
vscode-loc 语言包)。

## 行为

### 1. 应用菜单补高频命令(`app-menu-entries.spec.ts`)

命令项与既有菜单项同一机制(`MENU_COMMAND_IDS` 登记;点击经 `sendMenuCommand` 发往获焦窗口;键位是 renderer 推送的生效绑定,只显示)。

| 菜单 | 新增(命令 id) | VSCode 出处 |
|---|---|---|
| 文件 | 重新打开已关闭的编辑器(`workbench.action.reopenClosedEditor`,紧随「打开最近的文件夹…」) | `MenubarRecentMenu` `1_editor` |
| 文件 | 还原文件(`workbench.action.files.revert`)/ 关闭编辑器(`workbench.action.closeActiveEditor`)/ 关闭文件夹(`workbench.action.closeFolder`),与关闭窗口同组 | `MenubarFileMenu` `6_close`(fileActions.contribution / workspaceActions) |
| 显示 | 编辑器布局 ▸ 向右拆分(`workbench.action.splitEditor`)/ 向下拆分(`workbench.action.splitEditorDown`) | `MenubarViewMenu` `2_appearance` → `MenubarLayoutMenu` `1_split` |
| 显示 | 运行(`workbench.view.debug`,在 资源管理器 / 搜索 之后) | `MenubarViewMenu` `3_views`(debug.contribution `miViewRun`) |
| 转到 | 转到定义(`editor.action.revealDefinition`)/ 转到括号(`editor.action.jumpToBracket`)/ 下一个问题(`editor.action.marker.nextInFiles`) | `MenubarGoMenu` `4_symbol_nav` / `5_infile_nav` / `6_problem_nav` |
| 转到 | 切换组 ▸ 第 1 / 2 / 3 组(`workbench.action.focusFirst/Second/ThirdEditorGroup`) | `MenubarSwitchGroupMenu` `1_focus_index` |

### 2. 命令面板按 VSCode 说法找到设置 / 快捷键(`palette-entries.spec.ts`)

- `settings.toggle` 标题改为「首选项: 打开设置 / Preferences: Open Settings / 기본 설정: 설정 열기」(VSCode
  `workbench.action.openSettings` 的命令面板说法);搜「打开设置」「open settings」「preferences」都能找到。命令 id 与 ⌘, 行为不变。
- 命令可声明 `keywordsKey`(空格分隔的同义说法,当前语言 + 英文都参与):标题 / 英文原名都没命中时,查询的每个词都是关键词的子串
  就列出该命令(按词子串,不做模糊子序列),排在标题 / 英文命中之后,不重复列出。「打开键盘快捷方式」的关键词:快捷键 / 键位 / 键绑定 /
  热键(en keybindings / shortcuts / hotkeys / keymap);「打开设置」:偏好 / 选项 / 配置。

### 3. 帮助菜单(`app-menu-entries.spec.ts`)

- 顺序:显示所有命令 / 文档 / 显示发行说明 ‖ 键盘快捷方式参考 ‖ 报告问题 ‖ [Windows / Linux:关于 Continuo](VSCode `1_welcome` /
  `2_reference` / `3_feedback` / `z_about`)
- 文档 = package.json `homepage`、发行说明 = `homepage/releases`、报告问题 = `bugs.url`(`electron/main/help-links.ts` 的 `HELP_LINKS`,
  BDD 校验与 package.json 一致);点击经 `shell.openExternal` 打开,只允许 https
- 关于(仅 Windows / Linux;macOS 在应用菜单 role about):原生消息框(VSCode `NativeDialogHandler.about`),详情为 版本 / Electron /
  Chromium / Node.js / V8 / 操作系统(三语),按钮「复制」(把详情写进剪贴板)/「确定」;模态于获焦窗口

### 4. 活动栏「搜索」「运行和调试」(`ui-entries.spec.tsx`)

VSCode 活动栏默认 资源管理器 / 搜索 / 源代码管理 / 运行和调试 / 扩展,本项目有对应视图的是 资源管理器、搜索、运行和调试:按此顺序排在
插件 ribbon 图标之前;tooltip「搜索 (⇧⌘F)」「运行和调试 (⇧⌘D)」(键位随改绑,见 `hotkey-hints`);点击执行 `workbench.action.findInFiles`
/ `workbench.view.debug`(与快捷键同一命令)。图标为与齿轮同风格的线性 SVG。

### 5. 设置搜索框旁「筛选设置」菜单(`ui-entries.spec.tsx`)

VSCode `settingsSearchMenu`:搜索框右侧漏斗按钮(`aria-haspopup="menu"`),菜单项:

- 「已修改」:勾选项(`menuitemcheckbox`,查询里有整词 `@modified` 即勾选),点击追加 / 去掉 `@modified`(VSCode createToggleAction)
- 「设置 ID…」:把 `@id:` 追加到查询末尾,接着键入 id(VSCode doSearchWidgetAction;不弹补全)

选中后菜单关闭、焦点回搜索框。

### 6. 状态栏「侧栏已隐藏」可点(`ui-entries.spec.tsx`)

侧栏隐藏时该项是按钮:点击执行 `explorer.toggleSidebar`(同 ⌘B),title「显示侧栏 (⌘B)」(键位随改绑)。可访问名 = 可见文字。

## 与 VSCode 的差异

- 「重新打开已关闭的编辑器」放在文件菜单「打开最近的文件夹…」之后(本项目没有「打开最近 ▸」子菜单)
- 编辑器布局只有向右 / 向下拆分,切换组只有第 1–3 组(没有对应命令的不新造)
- 「上一个问题」「转到声明 / 类型定义 / 实现 / 引用」「源代码管理」「扩展」视图没有对应命令 / 视图,不加
- 帮助菜单没有欢迎页 / 视频教程 / 许可证 / 隐私声明等 VSCode 产品链接
- 设置筛选菜单只有本项目支持的 `@modified` / `@id:`(VSCode 另有 扩展 / 功能 / 标记 / 语言 / 策略等)
- VSCode 状态栏没有「侧栏已隐藏」项(本项目自有提示,做成可点)

## Specs

- `app-menu-entries.spec.ts`:文件 / 显示 / 转到新增项(键位跟随、点击发命令)、帮助菜单链接与关于对话框
- `palette-entries.spec.ts`:设置命令标题、关键词匹配
- `ui-entries.spec.tsx`:活动栏、设置筛选菜单、状态栏

相关:`hotkey-hints`(tab ✕「关闭 (⌘W)」、组「打开视图…」菜单的调试 / 输出键位)、`terminal-vscode-parity`(终端右键「清除终端 ⌘K」)、
`editor-preview-tab`(预览 tab 右键「保持打开」)、`app-menu-bar`(菜单结构总表)。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/app-menu.ts` | 菜单模板 |
| `electron/main/help-links.ts` | 帮助外链、关于对话框 |
| `electron/shared/window-channels.ts` | `MENU_COMMAND_IDS` |
| `src/plugins/command-palette/CommandPalette.tsx` | 关键词匹配(`searchDisplayCommands`) |
| `src/plugins/registries/CommandRegistry.ts` | `CommandSpec.keywordsKey` |
| `src/shell/IconSidebar.tsx` | 活动栏 |
| `src/plugins/settings/SettingsPanel.tsx` | 筛选设置菜单 |
| `src/shell/StatusBar.tsx` | 侧栏已隐藏按钮 |
