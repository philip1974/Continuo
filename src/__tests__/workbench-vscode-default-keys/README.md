# 已有命令补上 VSCode 默认键(⌘J / ⇧⌘D / ⇧⌘U / ⇧⌘V)

VSCode 迁移用户的常用键在 Continuo 里无反应,而对应命令其实已经存在(只能从命令面板执行)。按 VSCode 默认键补齐
(mac / Windows;Continuo 的平台模型不区分 Linux,按 Windows 取):

| 键(mac / Windows) | VSCode 命令 | Continuo 命令 | 条件 |
|---|---|---|---|
| ⌘J / Ctrl+J | `workbench.action.togglePanel`(切换面板) | `workbench.action.terminal.toggleTerminal` 的附加默认键 | 无 |
| ⇧⌘D / Ctrl+Shift+D | `workbench.view.debug`(运行和调试) | `workbench.view.debug`(View: Show Debug) | 无 |
| ⇧⌘U / Ctrl+Shift+U | `workbench.action.output.toggleOutput` | `workbench.view.output`(View: Show Output) | 无 |
| ⇧⌘V / Ctrl+Shift+V | `markdown.togglePreview` | 新增 `markdown.togglePreview`(Markdown: Toggle Preview) | `markdownEditorFocus` |

1. **⌘J**:本项目没有独立的底部面板,终端就是 VSCode 面板里最常用的那个 → 并到「切换终端」(主键仍是 ⌃`)。VSCode 的
   togglePanel 在 commandsToSkipShell 默认列表里 → 终端获焦时同样让出(不进 shell,Windows / Linux 的 Ctrl+J 也让出)。
2. **⇧⌘U 与代码编辑器**:CodeMirror 自带键表把 mac ⇧⌘U(其它平台 Alt+U)绑给「光标重做」(redoSelection),代码编辑器获焦时
   会先吞掉 ⇧⌘U。VSCode 的 cursorRedo 没有默认键 → 改为注册表命令 `cursorRedo`(Cursor Redo,无默认键),CodeMirror 键表去掉
   这两个键,编辑器里 ⇧⌘U 也打开输出。
3. **⇧⌘V 切换预览**(对齐 VSCode `markdown.togglePreview`,when `editorFocus && resourceLangId == markdown`):
   - 只在 Markdown 文档的编辑器获焦时生效(`markdownEditorFocus`):Markdown 编辑 / 预览(Milkdown 及其查找条),或源码模式的
     CodeEditor(语言为 Markdown 时 `.cm-editor` 带 `data-co-markdown-source`)。其它文件的编辑器、终端、输入框里不生效 ——
     Windows / Linux 的 Ctrl+Shift+V 在那里照常粘贴。
   - 不在预览 → 切到预览并记下原模式;在预览 → 回到原模式(没记过 → 源码,VSCode 预览回到文本编辑器)。切换后焦点进入新视图,
     再按一次即切回。
   - 取舍:Markdown 编辑模式(所见即所得)里 ⇧⌘V 原是浏览器的「粘贴为纯文本」。按 VSCode(其 Markdown 编辑器里 ⇧⌘V 同样是
     切换预览)归切换预览;mac 上「粘贴并匹配样式」⌥⇧⌘V(编辑菜单)仍可粘贴纯文本。
4. 全部进快捷键页:可改键 / 解绑。

## 规范

- `default-keys.spec.ts`:四个键的分发胜者(两平台)、⌘J 终端让出、⇧⌘U 不被 CodeMirror 吞、⇧⌘V 只在 Markdown 编辑器里胜出、
  切换预览往返与焦点
