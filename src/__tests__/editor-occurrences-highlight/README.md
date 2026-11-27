# 光标处单词的其它出现处(editor.occurrencesHighlight)

第五十三轮审计 2:光标停在词内(无选区)时不高亮该词的其它出现处。VSCode `editor.occurrencesHighlight` 默认 `singleFile`;
没有语言服务时 `wordHighlighter` 由 `TextualDocumentHighlightProvider` 兜底:取光标处单词(`getWordAtPosition`,光标紧挨词尾
也算),`findMatches(word, …, isRegex=false, matchCase=true, USUAL_WORD_SEPARATORS)` —— 区分大小写、全词匹配,结果含光标处那一个;
多行选区 / 选区超出单词不高亮。

1. **默认开**:光标在词上(含紧挨词尾)、无选区 → 该词在可见范围内的每个出现处(含光标处,`cm-selectionMatch-main`)高亮;
   区分大小写、按单词边界(`food` / `Foo` / `foo_bar` 不算 `foo`)。光标不在词上 → 不高亮。多光标不高亮。
2. 实现为 CodeMirror `highlightSelectionMatches({ highlightWordAroundCursor: true })`:与 basicSetup 里已有的「有选区时高亮相同文本」
   是同一个插件(配置按「或」合并),选区高亮行为不变;颜色同 `.cm-selectionMatch`(`--md-primary` 14%,token)。只扫可见范围,
   可见范围内超过 100 处不高亮(CodeMirror 默认 maxMatches),大文件不随行数变慢。
3. Markdown 源码模式同样生效(VSCode 文本兜底对所有语言)。
4. **设置 `editor.occurrencesHighlight`**(编辑器 → 外观,下拉 `off` / `singleFile`,默认 `singleFile`;VSCode 另有实验性的
   `multiFile` 跨文件高亮,不提供)。`off` 只关光标处单词高亮,有选区时的相同文本高亮照旧(那是 VSCode 的另一项
   `editor.selectionHighlight`)。改设置即时生效。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/codemirror-editor-guides.ts` | `wordOccurrencesHighlight`、`editorGuides(opts)` |
| `src/panels/Editor/CodeEditor.tsx` | 挂载与热切 |
| `src/plugins/settings/core-setting-specs.ts` / `src/core-plugins/EditorTabPlugin.ts` | `EDITOR_OCCURRENCES_HIGHLIGHT` 定义与注册 |

## 规范

- `occurrences-highlight.spec.tsx`:默认开(含光标处、区分大小写、全词)、词尾 / 非词位置、多光标、Markdown 源码模式、设置 off
  只关单词高亮 / 改回恢复、设置项与三语
- e2e `tests/e2e/editor-occurrences-highlight.spec.ts`:真实点击词内 → 其它出现处有高亮底色
