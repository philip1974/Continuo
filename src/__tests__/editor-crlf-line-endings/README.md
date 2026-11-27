# editor-crlf-line-endings

行为契约:**CodeEditor(代码文件 / Markdown Source 模式)保留 CRLF 文件的换行风格**。

此前 CodeMirror 默认按 `/\r\n?|\n/` 切行,`doc.toString()` 固定用 `\n` 拼接 → CRLF 文件一次按键后
回传 store 的全文全变 LF,与读盘原文 `originalContent`(`\r\n`)永不相等:撤销回原样仍 dirty、
关窗弹未保存、保存 / 自动保存把整文件改成 LF。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/editor-encoding.ts` | `detectLineEnding`(CodeEditor 再导出;状态栏行尾项同口径):全部换行是 CRLF 才判为 CRLF |
| `src/panels/Editor/CodeEditor.tsx` | emit 全文用 `doc.sliceString(0, len, eol)` 按文件风格拼接;外部重读按新内容重定风格 |

## 关键行为

- 纯 CRLF 文件:编辑后回传全文仍是 CRLF;保存写盘即 CRLF。
- 改后撤销回原样 → 全文与原文逐字节相等 → 不 dirty。
- 回车、粘贴 / 拖放 LF 多行文本 → 正常分行,落盘统一为 CRLF。
- LF 文件:行为不变。
- 混合换行(CRLF 与 LF / 孤立 CR 并存):维持既有行为,编辑后统一为 LF(任何单一风格都还原不了原文)。
- 外部重读(reload)改变换行风格 → 跟随新内容;仅换行风格不同、行内容相同 → 不整篇替换文档。
- 外部重读的光标 clamp 按文档坐标(CRLF 在文档里占 1 位),不越界抛错。

## 设计取舍

不用 `EditorState.lineSeparator` facet:它不改变 `doc.toString()`,且配置后 `state.toText` 只按该分隔符切行,
粘贴 / 拖放的 LF 多行文本会整段挤进一行(本目录粘贴用例对此做了变异验证)。

## 范围外

Milkdown(Markdown Edit 模式)的序列化器固定输出 LF,CRLF 的 `.md` 在 Edit 模式编辑后仍会变 LF;
Markdown 默认走 Source 模式(CodeEditor),不受影响。
