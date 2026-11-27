# 命令可发现性:应用菜单随界面语言 + 常用动作进命令面板(VSCode 对齐)

第二十五轮审计「命令可发现性」:macOS 菜单栏 role 项是 Electron 英文默认标签、应用菜单没有「设置…」;命令面板只有二十几条命令,
菜单 / 右键 / 标题栏按钮里的常用动作搜不到。对齐 VSCode:菜单随界面语言,应用菜单有「设置… ⌘,」;这些动作都是命令
(VSCode 的 `View: Close All Editors in Group`、`Developer: Reload Window`、`Markdown: Open Preview` 等)。

## 行为

### 1. 应用菜单随界面语言(`app-menu.spec.ts`)

- 菜单里每个 role 项(关于 / 服务 / 隐藏 / 退出、撤销 / 重做 / 剪切…、开发者工具 / 缩放 / 全屏、最小化 / 前置全部窗口…)都带
  `label: t(...)`(三语),role 保留(系统行为与默认快捷键不变);Edit / View / Window 三个顶层菜单也用三语标签
- Edit / View / Window 为显式子项(不再用 Electron 默认子菜单的英文标签);View 仍是「重新加载 / 强制重新加载」自定义项
  (先脏确认 + flush)+ 开发者工具 / 缩放 / 全屏
- Windows / Linux 的 Window 菜单不再带 role `close`(其 Ctrl+W 会直接关整窗);关窗口在 File 菜单(⇧Ctrl+W)
- 应用菜单(macOS)首选项 ▸ 有「设置… ⌘,」;其它平台在 File → 首选项 ▸。点击 = 命令 `settings.toggle`(经 `MENU_COMMAND_IDS` /
  `RUN_MENU_COMMAND`,popout 子窗聚焦时发给打开它的主窗);accelerator 显示命令当前生效的主键(见 `app-menu-bar`),一次按键只执行一次
  (renderer 热键先处理并 preventDefault,菜单 accelerator 不再触发)
- 切换界面语言 → 菜单整体重建(既有 `setMenuRebuilder`),标签跟随

### 2. 常用动作注册为命令(`workbench-commands.spec.ts`、`commands-behavior.spec.tsx`、`window-view-action-ipc.spec.ts`、`window-commands-popout.spec.ts`)

命令 id 照抄 VSCode(有对应的),三语标题 + 分类,命令面板可搜、快捷键设置页自动列出(无默认键;缩放三条例外,带 VSCode 默认键)。

| 命令 id | 标题(en) | 分类 | 动作(复用的现有实现) |
|---|---|---|---|
| `workbench.action.quickOpen` | Go to File… | — | 打开 Quick Open(⌘P 是保留键,不作命令默认键;只显示 ⌘P,见 `reserved-command-hotkeys`) |
| `workbench.action.showCommands` | Show All Commands | — | 打开命令面板(⇧⌘P 同上,只显示) |
| `workbench.action.closeWindow` | Close Window | Window | `coApi.window.close`(关窗脏确认) |
| `workbench.action.reloadWindow` | Reload Window | Window | `window:view-action` reload = 菜单 ⌘R(脏确认 + flush) |
| `workbench.action.zoomIn` / `zoomOut` / `zoomReset` | Zoom In / Zoom Out / Reset Zoom | View | 改设置项 `window.zoomLevel`(±1 级取整 / 恢复默认 0,所有窗口统一);带 VSCode 默认键,见 `src/__tests__/window-zoom/` |
| `workbench.action.toggleFullScreen` | Toggle Full Screen | View | `window:view-action` |
| `workbench.action.closeOtherEditors` | Close Other Editors in Group | View | 活动编辑器组的 tab 右键「关闭其他」 |
| `workbench.action.closeEditorsToTheRight` | Close Editors to the Right in Group | View | 「关闭右侧」 |
| `workbench.action.closeUnmodifiedEditors` | Close Saved Editors in Group | View | 「关闭已保存」 |
| `workbench.action.closeEditorsInGroup` | Close All Editors in Group | View | 「全部关闭」 |
| `copyFilePath` / `copyRelativeFilePath` | Copy Path / Copy Relative Path of Active File | File | tab 右键「复制路径 / 复制相对路径」 |
| `revealFileInOS` | Reveal Active File in Finder | File | tab 右键「在 Finder 中显示」(文件已删除的 tab 不动) |
| `markdown.switchToEditMode` / `SourceMode` / `PreviewMode` | Switch to Edit / Source / Preview Mode | Markdown | 编辑器的模式切换(含 unsafe 文档的确认框、较大文档的渲染提示) |
| `workbench.files.action.collapseExplorerFolders` | Collapse Folders in Explorer | Explorer | 资源管理器标题栏「全部折叠」 |
| `workbench.files.action.refreshFilesExplorer` | Refresh Explorer | Explorer | 标题栏「刷新」 |
| `workbench.action.closeFolder` | Close Folder | File | 标题栏菜单「关闭文件夹」 |
| `workbench.view.output` / `workbench.view.debug` | Show Output / Show Debug | View | 已有同类面板 → 激活;没有 → 新建(同 dock「⋯」菜单) |
| `workbench.action.moveEditorGroupToNewWindow` | Move Group into New Window | View | dock 标题栏「弹出到独立窗口」 |

- 编辑器类命令作用于活动编辑器组的活动 tab;资源管理器类作用于当前工作区的文件树;弹出作用于 dock 活动面板所在组
- 无上下文(无活动 tab / 无工作区 / 非 Markdown / 无活动面板 / 活动组已在子窗)→ 静默无操作(命令注册表无 when / enabled 机制)
- 关闭类与 tab 右键同一路径:脏 tab 弹「保存 / 不保存 / 取消」
- 主进程动作(重新加载 / 全屏)经 `window:view-action`(通用 IPC 外壳:受信 frame + zod;作用于发起方所在窗口)
- 窗口类命令作用于**触发它的窗口**(`getCommandDocument`:按键 / 菜单 / 命令面板所在窗口;VSCode 同)。popout 子窗里:
  - 关闭窗口 → 只关该子窗(子窗 `window.close()`,同菜单 ⇧⌘W:dockview 把子窗的组收回主窗,终端不结束),不经 `window:close`
    关主窗(此前子窗界面跑在主窗 renderer,IPC 发起方是主窗 → 关掉整个主窗连同终端)
  - 切换全屏 → `window:view-action` 带 `popoutName`(子窗的 window.open 名):main 只切**发起方打开的**同名子窗;不存在 /
    不归发起方 → `NO_WINDOW`(提示错误),不动任何窗口(VSCode toggleFullScreen 作用于活动窗口)
  - 重新加载窗口 → 重载主窗(子窗属于主窗 renderer;VSCode 辅助窗口里 reloadWindow 同样重载主窗):走同一的脏确认 + flush,
    子窗随主窗卸载关闭、随 dock 布局恢复
- 最小化 / 开发者工具 / 全屏(菜单)是菜单 role,作用于系统获焦窗口(含子窗),不经 renderer;缩放是全局设置

### 3. 命令标题大小写统一(`workbench-commands.spec.ts`)

- 英文命令标题统一 Title Case(VSCode 风格):「Toggle Explorer sidebar」→「Toggle Explorer Sidebar」;核心命令英文标题里
  首字母小写的只允许 `in / to / the / of / and / a / between` 等虚词

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/app-menu.ts` | 应用菜单模板(三语 label、显式子项、「设置…」) |
| `electron/main/index.ts` | `buildAppMenu`:注入开窗 / 重新加载动作;语言切换重建 |
| `electron/shared/window-channels.ts` | `MENU_COMMAND_IDS` 登记 `settings.toggle`;`VIEW_ACTION` 通道与动作表 |
| `electron/main/ipc/window.ipc.ts` | `window:view-action` |
| `src/shell/window-commands.ts` | 窗口类命令(Quick Open / 关闭 / 重新加载 / 缩放 / 全屏) |
| `src/shell/dock/dock-panel-actions.ts` | 显示输出 / 调试、弹出到独立窗口(dock「⋯」菜单与标题栏按钮共用) |
| `src/panels/Editor/editor-commands.ts` | 编辑器组关闭类、复制路径、在 Finder 中显示、Markdown 模式 |
| `src/panels/Explorer/explorer-commands.ts` | 折叠 / 刷新 / 关闭文件夹 |
