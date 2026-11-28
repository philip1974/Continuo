# 常用编辑器(CodeMirror)命令进命令注册表

对齐 VSCode 的文本编辑命令(命令 id、英文标题、mac 默认键与 VSCode 一致)。此前这些键只在 CodeMirror 键表里:快捷键页看不到、
不能改键 / 解绑,命令面板搜 comment / select / fold 为空;⌘L(VSCode 选中整行)无反应(CodeMirror 是 ⌃L),⇧⌘Enter(在上方插入行)
在编辑器里执行的是「切换终端缩放」。

1. **命令**(三语标题,与 VSCode 英文标题一致;Windows / Linux 取 VSCode Windows 默认键;附加默认键同 VSCode secondary):

   | id | 标题 | mac | Windows / Linux |
   |---|---|---|---|
   | `editor.action.commentLine` | Toggle Line Comment | ⌘/ | Ctrl+/ |
   | `editor.action.blockComment` | Toggle Block Comment | ⇧⌥A | Shift+Alt+A |
   | `editor.action.moveLinesUpAction` / `moveLinesDownAction` | Move Line Up / Down | ⌥↑ / ⌥↓ | Alt+↑ / Alt+↓ |
   | `editor.action.copyLinesUpAction` / `copyLinesDownAction` | Copy Line Up / Down | ⇧⌥↑ / ⇧⌥↓ | Shift+Alt+↑ / ↓ |
   | `editor.action.deleteLines` | Delete Line | ⇧⌘K | Ctrl+Shift+K |
   | `editor.action.insertLineAfter` / `insertLineBefore` | Insert Line Below / Above | ⌘Enter / ⇧⌘Enter | Ctrl+Enter / Ctrl+Shift+Enter |
   | `editor.action.indentLines` / `outdentLines` | Indent Line / Outdent Line | ⌘] / ⌘[ | Ctrl+] / Ctrl+[ |
   | `editor.action.addSelectionToNextFindMatch` | Add Selection to Next Find Match | ⌘D | Ctrl+D |
   | `editor.action.selectHighlights` | Select All Occurrences of Find Match | ⇧⌘L | Ctrl+Shift+L |
   | `editor.action.changeAll` | Change All Occurrences(同 selectHighlights 实现;编辑器右键菜单第一项) | ⌘F2 | Ctrl+F2 |
   | `editor.action.insertCursorAbove` / `insertCursorBelow` | Add Cursor Above / Below | ⌥⌘↑ / ⌥⌘↓ | Ctrl+Alt+↑ / ↓ |
   | `expandLineSelection` | Expand Line Selection | ⌘L | Ctrl+L |
   | `editor.fold` / `editor.unfold` | Fold / Unfold | ⌥⌘[ / ⌥⌘] | Ctrl+Shift+[ / ] |
   | `editor.foldAll` / `editor.unfoldAll` | Fold All / Unfold All | 无(VSCode 为 ⌘K 和弦,项目不支持和弦) | 无 |
   | `editor.action.jumpToBracket` | Go to Bracket | ⇧⌘\ | Ctrl+Shift+\ |
   | `cursorUndo` | Cursor Undo | ⌘U | Ctrl+U |
   | `cursorRedo` | Cursor Redo | 无(同 VSCode;CodeMirror 的 ⇧⌘U / Alt+U 去掉,⇧⌘U 归显示输出) | 无 |
   | 触发建议 / 扩展·收缩选区 / 格式化 / 重命名 / 转到定义 / 快速修复 / 下一个问题 | 见 `editor-language-commands` | | |
   | `actions.find` / `editor.action.startFindReplaceAction` | Find / Replace | ⌘F / ⌥⌘F | Ctrl+F / Ctrl+H |
   | `editor.action.nextMatchFindAction` / `previousMatchFindAction` | Find Next / Find Previous | ⌘G / ⇧⌘G(另有 F3 / ⇧F3) | F3 / ⇧F3 |

   查找类命令(菜单 编辑 → 查找 / 替换,见 `app-menu-bar`)条件为 `editorFocus`(查找面板里同样生效),键同样从 CodeMirror 键表
   去掉、经注册表分发,详见 `editor-find-keybindings`。

   全部进命令面板与快捷键页:可改键、解绑,改后旧键失效、新键生效。
2. **作用目标**:触发窗口的编辑器组(`commandEditorGroupId`)的活动文本编辑器(CodeMirror 视图)。没有文本编辑器(无 tab、
   图片、Markdown 编辑 / 预览模式)→ 静默不做任何事。从命令面板执行后焦点回到该编辑器。
3. **按键路由**:这些键从 CodeMirror 键表里去掉,统一走命令注册表的全局分发(改键 / 解绑才生效)。命令带上下文条件
   `when: 'editorTextFocus'`(对齐 VSCode `editorTextFocus`):只有按键落在代码编辑器(CodeEditor)的正文里才执行 ——
   - 终端、搜索框、查找面板输入框、其它输入框里不执行(⌘/、⌥↑ 等照常交给它们);
   - Milkdown 代码块里的 CodeMirror 不受影响(不是 CodeEditor);
   - 输入法组字中不执行;
   - CodeMirror 自己已处理的键(如补全弹窗里的方向键)不再执行(既有规则:编辑器已 preventDefault 的不分发);
   - popout 子窗里的编辑器同样生效(只作用于该子窗的编辑器)。
4. **同键不同上下文**(⇧⌘Enter):`editor.action.insertLineBefore`(editorTextFocus)与「切换终端缩放」(无条件)共用 ⇧⌘Enter ——
   编辑器正文获焦时在上方插入行,其它地方(终端)照旧切换缩放。分发表同一层内带条件的绑定排在无条件绑定之前;
   快捷键页的「冲突」只在后者被前者**完全**压过时标注(前者无条件,或两者条件相同),所以这一对不算冲突,
   注册表也不为它告警;改键弹窗同样不把条件不同的命令列为冲突。

5. **折叠 / 展开**(对齐 VSCode `editor.fold` / `editor.unfold`):折叠包住光标的最内层可折叠区域 —— 光标在区域任意一行(首行、
   中间、`}` 所在末行)都有效,不只在区域首行;最内层已折叠 → 折叠外一层;多光标各自折叠(同一区域只折一次);被折叠内容里的
   光标移到折叠起点(首行行尾),不藏在占位符后面;不在任何区域里 → 不动。展开:光标在折叠占位所在行即展开(多光标各自)。

6. **⌘D / ⇧⌘L 在大文档里不卡**(添加下一个匹配 / 选择所有匹配;⌘F2 同后者):搜索按块分片,与 ⌘F 匹配计数同一时间片(8ms)——
   按键当下先扫一个时间片,小文档就此扫完,行为与 CodeMirror 原命令逐项相同(同一结果、同一事务:整词、绕回、跳过已选、滚到新匹配、
   超过 1000 个匹配不做);扫不完的在后续宏任务里接着扫,期间界面照常响应。⇧⌘L / ⌘F2 光标在词内时直接用光标处单词开始扫描,
   不先单独选中该词(结果同原命令「选词 + 选择所有匹配」;超过 1000 个时只选中该词)。扫描期间只有文档变化影响它:改动都在已扫过的
   部分之后(日志在末尾持续追加)→ 接着扫,结果含新内容里的匹配;⇧⌘L 改到已扫过的部分 → 对新文档重扫;⌘D 改到选区或其之前 →
   作废。选区变化、只带 effect 的事务(大文档后台解析、外部追加时光标跟随末尾)不作废 ⇧⌘L;⌘D 扫完时选区已被用户改动则不加选区。
   同一命令在同一文档与选区下重复按不重复开扫描。此前对不再出现的词在 8.7 MB 日志里一次扫整篇,卡约 0.5s;大文档里 ⇧⌘L 先派发
   的选词事务会让后台扫描当场作废,只剩选中的那个词。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/editor-text-commands.ts` | 命令表(id / 标题 / 默认键)、命令 spec、取目标视图并执行 |
| `src/panels/Editor/codemirror-text-commands.ts` | 命令 id → CodeMirror 命令(引擎 chunk,CodeEditor 挂载时登记);在上方插入行等补充命令 |
| `src/panels/Editor/codemirror-basic-setup.ts` | 从 basicSetup 键表去掉改由注册表分发的键 |
| `src/panels/Editor/codemirror-occurrence-commands.ts` | ⌘D / ⇧⌘L 的分片搜索版本(语义同 @codemirror/search) |
| `src/lib/editor-text-focus.ts` | `editorTextFocus` 判定(按键是否落在 CodeEditor 正文) |
| `src/plugins/command-palette/useCommandHotkeys.ts` | 分发 / 冲突判定按 `when` 过滤与排序 |

## 规范

- `text-commands-registry.spec.ts`:命令 id / 标题 / 默认键、命令面板可搜到、改键 / 解绑
- `text-commands-dispatch.spec.ts`:`editorTextFocus` 分发(编辑器 / 终端 / 输入框 / Milkdown 代码块 / 组字)、⇧⌘Enter 区分、冲突不误报
- `text-commands-run.spec.ts`:作用于活动编辑器组的视图、各命令效果、无编辑器静默、CodeMirror 键表去掉这些键;⌘D 经注册表走分片搜索
- `text-commands-fold.spec.ts`:折叠包住光标的最内层区域(嵌套 / 首末行 / 多光标 / 光标不藏)、展开占位行
- `occurrence-commands-sliced.spec.ts`:小文档与 CodeMirror 原命令随机对照逐项相同(含跨块边界);大文档按键当下只扫一个时间片、之后扫完套用;⇧⌘L 空光标不先选词、扫描期间选区 / effect 不作废、末尾追加接着扫、改到扫过部分重扫;⌘D 末尾追加照样找到、改到选区前作废
