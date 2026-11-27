# editor-indentation

行为契约:**代码编辑器(含 Markdown 源码模式)按文档自己的缩进工作** —— 打开文档时按设置、语言默认与内容推断缩进,回车自动缩进、
Tab / ⇧Tab、⌘] / ⌘[ 都按它;状态栏显示并可更改;命令面板可切换 / 检测 / 转换。此前写死 CodeMirror 默认 2 空格:4 空格 Python
回车只缩 2 格、tab 缩进 Python 回车插 6 个空格、Makefile 里 Tab 插空格 → 代码跑不起来。

对照 VSCode `src/vs/editor/common/model/indentationGuesser.ts`(guessIndentation)、`textModelDefaults.ts`(tabSize 4 / insertSpaces
true / detectIndentation true)、`extensions/make` / `extensions/go` 的 `configurationDefaults`(`editor.insertSpaces: false`)、
`editor/contrib/indentation/browser/indentation.ts`(IndentUsingSpaces / IndentUsingTabs / DetectIndentation / IndentationToSpaces /
IndentationToTabs)、`workbench/browser/parts/editor/editorStatus.ts`(状态栏缩进项与 showIndentationPicker)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/indentation-guesser.ts` | guessIndentation 逐行移植(MIT 声明);只看前 10000 行 |
| `src/panels/Editor/editor-indentation.ts` | 设置 / 语言默认、按 tab 记的文档缩进 store、转换算法、设置变化重定 / 关闭清理(不 import CodeMirror) |
| `src/panels/Editor/CodeEditor.tsx` | 缩进 compartment(`indentUnit` + `EditorState.tabSize`),随文档缩进 reconfigure |
| `src/plugins/editor-encoding/indentation-actions.ts` | 5 个命令、状态栏缩进选择器的动作 / 宽度选择 |
| `src/plugins/editor-encoding/encoding-picks.ts`、`EncodingPickerModal.tsx`、`store.ts` | 复用编码 / 行尾选择器(popout 子窗里画在子窗) |
| `src/shell/StatusBar.tsx` | 状态栏缩进项 |
| `src/plugins/settings/core-setting-specs.ts`、`src/core-plugins/EditorTabPlugin.ts` | 设置 `editor.tabSize` / `editor.insertSpaces` / `editor.detectIndentation`(编辑器 › 缩进) |

## 关键行为

### 确定缩进(打开文档时一次,VSCode TextModel 创建时同)
- 默认值:`editor.tabSize`(默认 4,1..100)、`editor.insertSpaces`(默认开);Makefile(Makefile / makefile / GNUmakefile /
  OCamlMakefile、`.mk` / `.mak`)与 Go(`.go`)的 insertSpaces 默认关(语言默认高于全局设置,同 VSCode)。
- `editor.detectIndentation` 开(默认):按内容推断(VSCode 算法):有 tab 缩进的行多于纯空格缩进行 → 用 tab(宽度取默认值);
  反之用空格,宽度取相邻行缩进差出现最多的(候选 2,4,6,8,3,5,7;2 的次数 ≥ 4 的 2/3 时取 2;疑似对齐的续行不计);两者相等(含
  空文件 / 无缩进)→ 默认值。只看前 10000 行。关 → 直接用默认值。
- 之后编辑不重新推断;同一文档在多个编辑器组共享一份;关闭 / 改名后重开重新推断(不跨重启保存,VSCode 同)。

### 编辑
- 回车自动缩进、Tab / ⇧Tab(indentWithTab)、⌘] / ⌘[ 一级 = 缩进宽度个空格,或一个 tab;tab 宽度 = 缩进宽度。
- 4 空格 Python 行尾冒号回车 → 新行缩进 4 格;tab 缩进 Python 回车 → 插 tab(不混空格);Makefile 规则下 Tab → 插 tab。

### 状态栏
- 活动文本 tab:用空格「Spaces: 4 / 空格：4 / 공백: 4」,用 tab「Tab Size: 4 / 制表符长度：4 / 탭 크기: 4」(zh 按本仓库
  排版规范用全角冒号,VSCode 中文版为半角),位于编码项之前;
  Markdown 编辑 / 预览(Milkdown)不显示;图片 tab 不显示。
- 点击 → 选择器(占位「选择操作」):使用空格缩进 / 使用制表符缩进 / 从内容中检测缩进方式 / 将缩进转换为空格 / 将缩进转换为制表符。
  - 使用空格 / 制表符缩进 → 选宽度 1..8(初始选中当前;标注已配置 / 默认 / 当前制表符大小),对当前文档生效。
  - 检测:按当前内容推断(不看 detectIndentation 设置)。
  - 转换:整篇行首缩进转换(转空格 = 每个 tab 换成宽度个空格;转 tab = 每宽度个空格换成 tab,余下的空格保留),**一次撤销撤回**;
    之后文档改用空格 / tab,宽度不变。

### 命令(命令面板,无默认键;id / 英文标题同 VSCode)
`editor.action.indentUsingSpaces`「Indent Using Spaces」、`editor.action.indentUsingTabs`「Indent Using Tabs」、
`editor.action.detectIndentation`「Detect Indentation from Content」、`editor.action.indentationToSpaces`「Convert Indentation to
Spaces」、`editor.action.indentationToTabs`「Convert Indentation to Tabs」;作用于触发窗口编辑器组的活动 tab。

### 设置变化
- 三个设置任一变化 → 已打开文档全部按新设置重新确定(含在选择器里选过的;VSCode ModelService 同),编辑器即时生效。

## 与 VSCode 的差异 / 范围外
- 缩进宽度与 tab 显示宽度不分开(无 `editor.indentSize`、无「更改制表符显示大小」);选择器不列「删除尾随空格」、无分组标题。
- 语言级设置(`"[python]": {...}`)不支持,只内置 Makefile / Go 的默认。
- `.editorconfig` 不读(VSCode 本身也需要扩展)。
- Tab 键沿用 CodeMirror indentWithTab(整行缩进一级),不是 VSCode 的「光标处插到下一个 tab stop」。
