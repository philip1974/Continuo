# 自动换行的续行缩进(VSCode editor.wrappingIndent: same)

第五十四轮审计 A1:`editor.wordWrap` 开着时,缩进两级的超长行折出来的续行从第 0 列开始,缩进参考线竖穿续行文字。
VSCode `editor.wrappingIndent` 默认 `same`:续行与首行缩进对齐,参考线落在空白区。

1. **续行与首行缩进对齐**:开了自动换行,有缩进的行在 `.cm-line` 上加悬挂缩进(`padding-left` + N 列、`text-indent` − N 列):
   首行位置不变,续行右移 N 列。N 照 VSCode `computeWrappedTextIndentLength`:只数行首空白,空格 1 列、tab 跳到下一个
   tabSize 倍数列;顶格行与整行空白的行不缩进。
2. **放不下时退回**:缩进 + 一个全角字符(2 列)超过一个视觉行能放的列数 → 续行不缩进(VSCode「Force sticking to beginning
   of line if no character would fit except for the indentation」)。
3. **只在自动换行开时**:关掉 `editor.wordWrap` 即去掉(同一视图热切);状态栏改 tab 宽度即时重算。Markdown 源码模式
   (同一个 CodeMirror 编辑器)同样生效。
4. **定位不错位**:光标、点击、选区按 DOM 实测;续行首字的屏幕 x 等于首行首个非空白字符的 x(e2e 实测)。
5. **大文件**:只为可见行生成装饰、只读行首空白。

刻意差异:VSCode 另有 `none / indent / deepIndent` 三档;本项目只做默认 `same`,不加设置(极简)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/codemirror-wrapping-indent.ts` | `wrappedIndentColumns`(列数与退回)、`wrappingIndent`、`editorWordWrap(on)` |
| `src/panels/Editor/CodeEditor.tsx` | 换行 Compartment 装 `editorWordWrap` |

## 规范

- `wrapping-indent.spec.tsx`:列数(空格 / tab / 混合 / 空白行 / 放不下退回)、换行开时的行装饰、关换行即去掉、tab 宽度变化重算、
  Markdown 源码模式
- e2e `tests/e2e/editor-wrapping-indent.spec.ts`:真实渲染的续行首字与首行缩进对齐、参考线在续行文字左侧、点击续行定位正确
