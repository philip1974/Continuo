# 应用菜单栏补全 + 「首选项:打开键盘快捷方式」

此前菜单只有 应用 / 文件 / 编辑 / 显示 / 窗口 五个,近期加进命令注册表的命令(全部保存、打开最近、后退 / 前进、转到行、
切换注释、移动行…)在菜单里找不到;菜单项上的快捷键是写死的,改键后与实际不符。对齐 VSCode mac 菜单栏
(`src/vs/platform/menubar/electron-main/menubar.ts` + 各 `MenuId.MenubarXxxMenu` 贡献),只取关键入口。

## 行为

### 1. 菜单结构(`menu-template.spec.ts`)

顶层顺序同 VSCode:应用(仅 macOS)/ 文件 / 编辑 / 选择 / 显示 / 转到 / 终端 / 窗口 / 帮助。

| 菜单 | 命令项(命令 id) |
|---|---|
| 应用(macOS) | 首选项 ▸ 设置…(`settings.toggle`)、键盘快捷方式(`workbench.action.openGlobalKeybindings`);其余 role 项不变 |
| 文件 | 新建窗口、打开文件夹…(`workbench.action.files.openFolder`)、在新窗口中打开文件夹…、打开最近的文件夹…(`workbench.action.openRecent`)、重新打开已关闭的编辑器、全部保存(`workbench.action.files.saveAll`)、自动保存(勾选项 `workbench.action.toggleAutoSave`,见 `files-auto-save`)、[Windows / Linux:首选项 ▸]、还原文件 / 关闭编辑器 / 关闭文件夹 / 关闭窗口(见 `entry-discoverability`) |
| 编辑 | 撤销 / 重做(按焦点分派,见第 6 条)、剪切 / 复制 / 粘贴…(role 不变)、查找(`actions.find`)、替换(`editor.action.startFindReplaceAction`)、在文件中查找(`workbench.action.findInFiles`)、切换行注释 / 块注释(`editor.action.commentLine` / `blockComment`) |
| 选择 | 全选(role)、展开行选择(`expandLineSelection`)、向上 / 向下复制一行、向上 / 向下移动一行、在上面 / 下面添加光标、添加下一个匹配项(`addSelectionToNextFindMatch`)、选择所有匹配项(`selectHighlights`) |
| 显示 | 命令面板…(`workbench.action.showCommands`)、编辑器布局 ▸ 向右 / 向下拆分、资源管理器(`workbench.view.explorer`)、搜索(`workbench.action.findInFiles`)、运行(`workbench.view.debug`)、终端(`workbench.action.terminal.toggleTerminal`)、输出(`workbench.view.output`)、切换侧栏(`explorer.toggleSidebar`)、自动换行(`editor.action.toggleWordWrap`)、重置缩放 / 放大 / 缩小(`workbench.action.zoomReset` / `zoomIn` / `zoomOut`,所有窗口统一,见 `src/__tests__/window-zoom/`);重新加载 / 开发者工具 / 全屏不变 |
| 转到 | 返回 / 前进(`navigateBack` / `navigateForward`)、转到文件…(`quickOpen`)、转到编辑器中的符号…(`gotoSymbol`)、转到定义、转到行/列…(`gotoLine`)、转到括号、下一个问题、下一个 / 上一个编辑器、切换组 ▸ |
| 终端 | 新建终端(`terminal.new`)、切换终端(`workbench.action.terminal.toggleTerminal`) |
| 帮助(role help) | 显示所有命令、文档、显示发行说明、键盘快捷方式参考(= 打开键盘快捷方式;VSCode 打开 PDF 速查表)、报告问题、[Windows / Linux:关于](外链与关于见 `entry-discoverability`) |

- 每个标签三语齐全(`menu.*`),界面语言切换时菜单整体重建(既有 `setMenuRebuilder`)
- 原生编辑项(cut / copy / selectAll…)保留 role;撤销 / 重做是自定义项(第 6 条)
- 命令项点击 → `sendMenuCommand(获焦窗口, id)`;打开文件夹在没有可用主窗时(macOS 关光窗口)在新窗口打开

### 2. 快捷键显示跟随生效键位(`menu-keybindings.spec.ts`)

- renderer 计算菜单命令当前生效的主键(与命令面板 / tooltip 同一规则:改键跟随、解绑不显示、冲突落败不显示,⌘P / ⇧⌘P
  显示保留键),归一后经 `window:set-menu-keybindings` 推给 main;有变化才重建菜单
- main 换算成 Electron accelerator(`meta` → mac `Command` / 其它 `Super`,`arrowup` → `Up`,`enter` → `Return`,`+` → `Plus`…;
  无法表示的键不显示);推送只认菜单命令 id(其余忽略)
- 命令项都带 `registerAccelerator: false`:只显示,按键由 renderer 的全局热键分发处理(Windows / Linux 上该选项生效)。
  **macOS 上 Electron 不支持该选项**(仅 linux / win32):按键先到 renderer,renderer 处理并 preventDefault 后菜单不再触发;
  renderer 没处理的按键才会触发菜单 → 点击事件带 `triggeredByAccelerator`,main 转成 `viaKey` 交给 renderer 按命令上下文条件
  重新判定(VSCode 同:accelerator 触发的菜单项交给渲染进程按键位重新解析)

### 3. 菜单命令作用于正确的窗口(`menu-command-routing.spec.ts`)

- main:获焦的是 popout 子窗 → 发给打开它的主窗,payload 带 `fromPopout: true`(子窗界面由主窗 renderer 驱动)
- renderer:`fromPopout` → 命令文档是获焦的子窗(`runInCommandDocument`,与热键分发同一机制);否则主窗。窗口级命令
  (切换终端、后退…)与编辑器命令都作用于该窗口
- 编辑器命令(切换注释 / 移动行 / 查找…,`when: editorTextFocus` / `editorFocus`)从菜单**点击**:作用于该窗口编辑器组的活动
  文本编辑器(与命令面板一致),没有文本编辑器 → 静默(VSCode 菜单项同样不置灰,选简单方案;「查找」例外:Markdown 编辑 / 预览
  打开其查找条,见 `editor-find-keybindings`);`viaKey` 时焦点不在代码编辑器正文(查找类:代码编辑器内)→ 不执行(终端里按 ⌘/
  不去注释编辑器)
- 任一窗口有 Modal 打开 / 焦点在菜单里 → 不执行(既有规则)

### 4. 「首选项:打开键盘快捷方式」(`open-keybindings.spec.ts`)

- 命令 `workbench.action.openGlobalKeybindings`,分类「Preferences / 首选项 / 기본 설정」,标题「Open Keyboard Shortcuts / 打开键盘快捷方式 /
  바로 가기 키 열기」(VSCode「Preferences: Open Keyboard Shortcuts」);无默认键(VSCode ⌘K ⌘S 为和弦,不支持)
- 打开设置并切到快捷键页,焦点落到该页搜索框;设置已打开(哪怕正在别的页)→ 切到快捷键页,不关闭设置
- 焦点请求只用一次:之后在设置里切走再切回快捷键页,不再抢焦点

### 5. 查找 / 替换命令(`open-keybindings.spec.ts` 同文件末尾)

- `actions.find`(Find,⌘F / Ctrl+F)、`editor.action.startFindReplaceAction`(Replace,mac ⌥⌘F,其它 Ctrl+H),`when: editorFocus`
- 执行 = 在活动文本编辑器打开查找面板 / 替换框(焦点留在面板里);键经命令注册表分发(可改键,查找面板内同样生效,见
  `editor-find-keybindings`);终端里 ⌘F 仍是终端查找(上下文条件不同,不算冲突)

### 6. 「编辑 → 撤销 / 重做」按焦点分派(`menu-undo-routing.spec.ts`、`menu-template.spec.ts`)

VSCode 菜单的撤销 / 重做是 `undo` / `redo` 多实现命令(`UndoCommand.addImplementation`,资源管理器实现
`src/vs/workbench/contrib/files/browser/files.contribution.ts`:`explorerService.hasViewFocus()` 且有可撤销项 → 撤销文件操作,
否则交给下一个实现,最终是原生 / 编辑器撤销)。这里:

- 菜单项 id `undo` / `redo`,不是 role;键位同 Electron role 默认(撤销 CmdOrCtrl+Z;重做 Windows Control+Y,其它
  Shift+CmdOrCtrl+Z)
- 按键触发(`triggeredByAccelerator`:按键已先经 renderer 而未被处理,文件树 / CodeMirror / Milkdown 自己处理 ⌘Z)→ main 直接对获焦的
  webContents 原生撤销 / 重做(同原 role 项;输入框 / 终端照旧)
- 鼠标点击 → 发 `window:edit-undo-redo { op, fromPopout }` 给目标主窗(popout 子窗获焦 → 打开它的主窗);DevTools 获焦 / 无可用主窗 →
  直接原生
- renderer:获焦窗口的文档焦点在资源管理器文件树的行 / 树容器上(改名 / 新建输入框不算,同树内 ⌘Z 的条件)、没有 Modal、有工作区 →
  撤销 / 重做文件操作(同 `explorer.undo` / `explorer.redo`,见 `explorer-file-undo`);焦点在编辑器正文 → 用编辑器自己的撤销栈
  (VSCode `CoreEditingCommands.Undo` / `Redo` 的 `runEditorCommand`:`editor.getModel().undo()`):代码编辑器 / Markdown 源码等
  CodeMirror → `@codemirror/commands` 的 `undo` / `redo`;Markdown 编辑(ProseMirror,含其代码块)→ 在 ProseMirror 根上派发
  `beforeinput` `historyUndo` / `historyRedo`(prosemirror-history 处理)。命令产生的修改(切换注释 / 缩进 / 替换 / 还原)与重做都能
  由菜单撤销 / 重做(Chromium 原生撤销栈没有这些,栈空时不派发)。其它(输入框 / 编辑器内查找框 / 终端 / Modal)经
  `window:view-action` 的 `undo` / `redo` 请 main 对该窗口(popout → 该子窗)做 `webContents.undo()` / `redo()`(VSCode `runDOMCommand`)

## 与 VSCode 的差异

- 只取关键入口;没有 打开最近 ▸ 子菜单(打开的是最近文件夹选择器)、Run 菜单、扩展 / 源代码管理等视图(显示 ▸ 运行 = 调试视图)
- 首选项 ▸ 设置 = `settings.toggle`(命令面板标题「首选项: 打开设置」;已显示时再点会关闭,与 ⌘, 一致)
- 帮助 → 键盘快捷方式参考打开设置的快捷键页(VSCode 打开 PDF)
- 选择菜单的「展开行选择」对应 `expandLineSelection`(VSCode 选择菜单是语法级「扩大选区」)
- 编辑菜单保留「全选」(选择菜单也有)

## E2E

`tests/e2e/app-menu-bar.spec.ts`:E2E 模式下应用菜单为 null,经 main 的 e2e 钩子(仅 `CONTINUO_E2E=1`)读取同一模板、按菜单
路径调用菜单项的 click(与真实点击同一路径),验证 accelerator 跟随改键、主窗 / popout 子窗里执行正确;编辑 → 撤销 / 重做在代码编辑器里
撤销输入后可重做、打开文件后只做命令修改(切换行注释)也能撤销、popout 子窗的代码编辑器里同样生效、Markdown 编辑里撤销后可重做,
文件树聚焦时撤销 / 重做改名。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/app-menu.ts` | 菜单模板(纯函数,`acceleratorOf` 可注入) |
| `electron/main/menu-keybindings.ts` | 推送键位的存储、hotkey → accelerator |
| `electron/main/lib/menu-command.ts` | 菜单命令发往哪个窗口、payload;撤销 / 重做的分派(`runEditUndoRedo`) |
| `electron/shared/window-channels.ts` | `MENU_COMMAND_IDS`、`SET_MENU_KEYBINDINGS`、payload 校验 |
| `src/shell/menu-commands.ts` | renderer 执行菜单命令、推送生效键位、撤销 / 重做按焦点分派 |
| `src/core-plugins/KeybindingsTabPlugin.ts` | 打开键盘快捷方式命令 |
