# 编辑器查找类命令经命令注册表分发(可改键);菜单「查找」在 Markdown 编辑 / 预览里同样生效

对齐 VSCode `actions.find` / `editor.action.startFindReplaceAction` / `editor.action.nextMatchFindAction` /
`editor.action.previousMatchFindAction`(when 含 `editorFocus`:查找控件里同样生效)。此前 ⌘F / ⌥⌘F / ⌘G / ⇧⌘G / F3 / ⇧F3
在代码编辑器(CodeEditor)里由 CodeMirror 键表直接处理:把「查找」改到 ⇧⌘G、把别的命令绑到 ⌘F 后,⌘F 仍打开查找面板,新键
⇧⌘G 又被 CodeMirror 的「查找上一个」抢走 —— 与另外 22 个已进注册表的编辑器命令不一致。

## 行为

1. **命令**(三语标题;英文同 VSCode):

   | id | 标题 | mac | Windows / Linux |
   |---|---|---|---|
   | `actions.find` | Find | ⌘F | Ctrl+F |
   | `editor.action.startFindReplaceAction` | Replace | ⌥⌘F | Ctrl+H |
   | `editor.action.nextMatchFindAction` | Find Next | ⌘G(另有 F3) | F3 |
   | `editor.action.previousMatchFindAction` | Find Previous | ⇧⌘G(另有 ⇧F3) | ⇧F3 |

   上下文条件 `when: editorFocus`:按键落在代码编辑器里(正文**或其查找面板**)才执行;终端(⌘F = 终端查找)、其它输入框、
   Milkdown 及其代码块不受影响。Windows / Linux 的 Ctrl+G 仍是转到行(VSCode 同)。
2. **改键**:这些键已从 CodeEditor 的 CodeMirror 键表去掉,统一经注册表分发 —— 改键后旧键失效(交给新绑定的命令)、新键生效、
   不被 CodeMirror 抢走;解绑同理。Esc 关闭查找面板、查找框里 Enter / ⇧Enter、⌥⌘C / W / R 选项切换仍由面板处理。
3. **查找面板里**:按「查找」的键 → 聚焦并全选查找框(VSCode 同);按「查找下一个 / 上一个」的键 → 跳到下一个 / 上一个匹配;
   按「替换」的键 → 聚焦替换框。
4. **Markdown 代码块**(Crepe 的 CodeMirror,不经注册表)保留 CodeMirror 自带的查找键与 ⌥⌘F / Ctrl+H 替换键,行为不变。
5. **菜单 / 命令面板的「查找」在 Markdown 编辑 / 预览(Milkdown)里**:打开该编辑器的查找条(同在其中按 ⌘F:焦点在正文且有单行
   选区 → 带入选区文字)。「替换」在 Markdown 编辑 / 预览里不支持 → 静默(同 VSCode 对不支持替换的编辑器)。Milkdown 里直接按
   ⌘F / F3 的既有行为不变。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/editor-text-commands.ts` | 命令表(含查找类,`when: editorFocus`);无 CodeMirror 视图时「查找」转给 Markdown 查找条 |
| `src/panels/Editor/codemirror-text-commands.ts` | 命令 id → CodeMirror 命令(openFindPanel / openReplacePanel / findNext / findPrevious);ROUTED_KEYMAP_COMMANDS |
| `src/panels/Editor/codemirror-basic-setup.ts` | 从 basicSetup 键表去掉 ⌘F / ⌘G / F3 等(按命令) |
| `src/panels/Editor/codemirror-find.ts` | `codeEditorFind`(CodeEditor,无替换键)/ `codeMirrorFind`(Markdown 代码块,带替换键);openFindPanel 全选查找框 |
| `src/lib/editor-text-focus.ts` | `editorFocus` 判定(按键在 CodeEditor 里,含查找面板) |
| `src/panels/Editor/markdown-find-registry.ts` | Markdown 查找条的打开入口(MilkdownEditor 按组 + tab 登记) |

## 规范

- `find-keybindings.spec.ts`:命令表、按键分发(正文 / 查找面板 / 终端 / 代码块)、改键后旧键失效新键生效、CodeMirror 键表去掉这些键
- `markdown-menu-find.spec.tsx`:Markdown 编辑 / 预览里执行「查找」打开查找条(带入选区),「替换」静默
