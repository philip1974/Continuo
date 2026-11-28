# 编辑器剪贴板(复制 / 剪切 / 粘贴,对齐 VSCode)

代码编辑器(CodeEditor、冲突比较;Markdown 源码模式同)与 Markdown 编辑模式(Milkdown)的复制粘贴语义。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/codemirror-clipboard.ts` | CodeMirror copy / cut / paste 处理:整行复制、编辑器元数据、多光标分配、撤销断点 |
| `src/panels/Editor/copy-html.ts` | 带语法高亮的 HTML(格式照 VSCode getRichTextToCopy / tokenizeLineToHTML) |
| `src/panels/Editor/codemirror-basic-setup.ts` | 把上面的处理装进 basicSetup(读设置 `editor.copyWithSyntaxHighlighting`) |
| `src/panels/Editor/milkdown-paste.ts` | Milkdown 粘贴撤销断点、代码编辑器来的内容按 Markdown 解析、网页 HTML 的图片 title / 代码块语言 |

## 行为

### 1. 无选区复制 / 剪切整行(VSCode `editor.emptySelectionClipboard` 默认开)(`clipboard-copy-paste.spec.ts`)

- 全部光标都没有选区:⌘C / ⌘X 复制光标所在整行,剪贴板文本**带行尾换行**(外部应用粘贴得到完整一行);多个光标在不同行 →
  各行依次相接(同一行只取一次)。VSCode 多光标时各行再用换行拼接(外部粘贴多出空行),刻意不照搬
- 同时写编辑器元数据(DataTransfer 自定义类型 `application/x-continuo-editor`,JSON:`version` / `linewise` / `multicursorText` /
  `mode`;对应 VSCode `vscode-editor-data`)。Chromium 把自定义类型放进系统剪贴板,另一个窗口(渲染进程)粘贴同样读得到
- 有非空选区:只复制非空选区(多段用换行拼接,`multicursorText` 带各段);与 CodeMirror 原行为相同
- 剪切整行的删除范围照 VSCode `DeleteOperations.cut`:非末行删到下一行行首;末行(且不止一行)连同前一个换行删掉;只有一行 →
  删掉该行内容(行本身留下)。光标落在删除处
- 只读编辑器:复制照常,剪切只复制不删除

### 2. 粘贴(`clipboard-copy-paste.spec.ts`)

- 元数据标明整行且光标都无选区 → 整行插到各光标所在行**上方**,光标随原位置下移一行(VSCode `pasteOnNewLine` +
  `ReplaceCommandThatPreservesSelection`);同一行的多个光标只插一次
- 多光标:元数据的段数 = 光标数 → 逐个分配;否则(非整行)剪贴板文本去掉末尾一个换行后行数 = 光标数 → 按行分配
  (VSCode `multiCursorPaste` 默认 spread);否则每个光标都粘贴全文
- 外部内容(无元数据)→ 替换选区,行为同前
- 粘贴、剪切各自成为一次撤销,前后都断开(`isolateHistory: full`;VSCode 粘贴 / 剪切前后各压撤销停止点):粘贴后 500ms 内接着
  输入,撤销只撤掉输入
- 只有文件 / 图片(无文本)的粘贴交给后面的处理(Markdown 源码模式粘贴图片,见 `markdown-image-paste`)

### 3. 复制带语法高亮的 HTML(VSCode `editor.copyWithSyntaxHighlighting` 默认开)(`clipboard-copy-html.spec.ts`)

- 复制 / 剪切时另写 `text/html`:外层 `<div style="color; background-color; font-family; font-weight; font-size(px);
  line-height(px); white-space: pre;">`,每行 `<div><span style="color: …;">…</span></div>`,空行 `<br>`;未高亮文字用外层前景色
- `< > &` 转义;Tab 按 tab 宽度从行首累计展开成空格(全角字符按 2 列计),Windows 上空格 / Tab 交替用 `&#160;`(VSCode 同)
- 颜色、字体取编辑器当前计算样式:语法色由高亮类名在编辑器里实测(亮 / 暗 / 高对比度跟随主题)
- 只在**单个**选区时给 HTML(多光标 / 多选区只写纯文本,VSCode 同);无选区整行复制给该行(不含换行)的 HTML
- 纯文本(无语言)不给 HTML;复制的文本 ≥ 65536 字符不给 HTML(VSCode 同阈值)
- 设置「编辑器 → 复制时带语法高亮」(`editor.copyWithSyntaxHighlighting`,默认开,三语)关掉 → 只写纯文本与元数据

### 4. Markdown 编辑模式(`milkdown-paste.spec.ts`)

- 粘贴前后断开撤销(prosemirror-history 默认把 500ms 内相邻改动并成一组):粘贴后紧接着输入,撤销只撤掉输入
- 从代码编辑器复制来的内容(带编辑器元数据)按纯文本当 Markdown 解析,不用随附的高亮 HTML(源码模式复制的 `# 标题`
  粘回编辑模式仍是标题)
- 粘贴网页 HTML:图片 `title` 只取 `title` 属性(上游缺省回落到 `alt`);代码块语言依次取 `<pre data-language>` /
  `<pre data-lang>` / `<code data-language>` / `<code data-lang>` / `<code class="language-*">` / `lang-*`(code 或 pre 上),
  只认语言名形状的值(字母数字与 `+ # . - _`,≤ 64),取不到 → 无语言
