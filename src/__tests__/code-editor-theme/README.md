# code-editor-theme

行为契约:**代码编辑器(代码文件 + Markdown Source 模式)与应用同一套设计 token,亮 / 暗都成立;Markdown 的 YAML frontmatter 不被误当标题。**

## 行为

- 编辑器背景、gutter、当前行、选区、光标、面板 / 提示框取自 `--md-*` token,字体取设置 `editor.fontFamily` 的 `--wm-editor-font-family`(缺省 `--wm-font-mono`,见 font-settings);一套样式同时适配
  `:root`(亮)与 `.dark`(暗),底色与画布 / 终端 / Markdown 编辑器一致(不再是 oneDark 的 `#282c34`)。
- 语法高亮:一套 HighlightStyle,颜色只引用 `theme.css` 的 Continuo 自有槽位 `--md-syntax-*`(keyword / name / function /
  constant / definition / type / operator / comment / string / heading / link / invalid),`:root` 与 `.dark` 各一套值:
  暗色 = oneDark 原值,亮色 = One Light 同色相加深;两主题每个语法色对编辑器底色 `--md-surface` ≥ 4.5(原亮色 One Light
  注释 2.51 / 字符串 3.13 / 类型 3.12 / 属性 3.58)。组件里不写字面 hex;标题只加粗、不加下划线。切主题靠 `<html class="dark">`
  即时换色(亮 / 暗挂的是同一个 HighlightStyle)。
- 聚焦时不画 CodeMirror 基础主题的 `1px dotted` 轮廓(`&.cm-focused { outline: none }`;VSCode 编辑器聚焦无边框,光标 / 当前行即焦点指示),
  Markdown 代码块的 CodeMirror 同样。
- 暗色向 CodeMirror 声明 dark 主题(内建样式选暗色变体),亮色不声明。切换主题热替换,不重建编辑器。
- Markdown 编辑模式(Crepe)的代码块用同一套 token 外观 + `--md-syntax-*` 高亮(`markdownCodeBlockTheme`),不再是 Crepe
  默认的 oneDark(亮色主题下仍是深色配色);亮 / 暗共用一个扩展(不声明 dark),切主题不重挂编辑器。代码块底色由 Crepe CSS
  取 `--md-surface-container`,每个语法色对它两主题均 ≥ 4.5。
- Markdown(`forceLanguage='markdown'` 或 `.md` / `.markdown` 文件):文首 `---` 包起来的 frontmatter 按 YAML 解析高亮;
  不在文首的 `---` 等照常按 Markdown 解析。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/code-editor-theme.ts` | token 化的编辑器外观 + 亮 / 暗语法高亮;`markdownCodeBlockTheme` 供 Crepe 代码块 |
| `src/panels/Editor/CodeEditor.tsx` | 按主题热切 `codeEditorTheme`;Markdown 用 `yamlFrontmatter({ content: markdown() })` |

## Specs

| File | 覆盖 |
|---|---|
| `code-editor-theme.spec.tsx` | frontmatter 解析树、注入样式取 token、dark facet、亮色标题无下划线、`--md-syntax-*` 两主题对偶 + ≥ 4.5 + 无字面 hex + 亮暗同一 HighlightStyle;Markdown 代码块主题同 HighlightStyle、不声明 dark、语法色对 surface-container ≥ 4.5 |
