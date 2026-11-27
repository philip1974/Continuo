# 缩进参考线(editor.guides.indentation)

第五十三轮审计 1:代码编辑器没有缩进参考线。VSCode `editor.guides.indentation` 默认 `true`(每一级缩进画一条竖线),
`editor.guides.highlightActiveIndentation` 默认 `true`(光标所在块的那一条高亮);对 Markdown 没有语言级覆盖。

1. **默认开**:代码编辑器与 Markdown 源码模式里,有缩进的行在每一级缩进列的左边缘画 1px 竖线(VSCode indentGuides:
   left = 缩进列 × 空格宽);顶格行不画。空行延续上下文的缩进(块中间的空行不断线)。
2. **按文档缩进计级**:级宽 = 文档的缩进单位(打开时按内容推断 / 设置,见 `editor-indentation`;状态栏改缩进即时重算),
   tab 按 tabSize 折算列。2 空格文件里缩 2 格就是一级。
3. **当前块高亮**:光标所在块的那一级用 `--md-indent-guide-active`,其余用 `--md-indent-guide`(VSCode
   `editorIndentGuide.background1` / `activeBackground1`;亮 / 暗都给值,`theme.css`)。光标移动随之更新。
4. **设置 `editor.guides.indentation`**(编辑器 → 外观,布尔,默认开;三语说明照 VSCode「Controls whether the editor should
   render indent guides.」/「控制编辑器是否显示缩进参考线。」/「편집기에서 들여쓰기 가이드를 렌더링할지 여부를 제어합니다.」)。
   改设置即时生效(Compartment 重配置,不重建编辑器、不丢光标 / 撤销历史)。
5. **大文件**:只为可见行生成行装饰(`@replit/codemirror-indentation-markers`,MIT),不随文件行数变慢;e2e 量 10 万行与
   2 MB 单行 minified 文件的打开 / 滚动 / 输入耗时与关掉设置时对比。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/codemirror-editor-guides.ts` | `indentGuides`(库 + 颜色 token + 列边缘对齐)、`editorGuides(opts)` |
| `src/panels/Editor/CodeEditor.tsx` | 挂载与热切(与 `editor.occurrencesHighlight` 同一个 Compartment) |
| `src/plugins/settings/core-setting-specs.ts` / `src/core-plugins/EditorTabPlugin.ts` | `EDITOR_GUIDES_INDENTATION` 定义与注册 |
| `src/styles/theme.css` | `--md-indent-guide` / `--md-indent-guide-active`(`:root` 与 `.dark`) |

## 规范

- `indent-guides.spec.tsx`:默认开 / 顶格不画、按文档缩进计级(2 空格 / tab)、当前块高亮随光标、Markdown 源码模式、设置热切、
  颜色 token(亮 / 暗)、设置项注册与三语
- e2e `tests/e2e/editor-indent-guides.spec.ts`:真实渲染的竖线位置对齐缩进列、当前块颜色不同;大文件性能
