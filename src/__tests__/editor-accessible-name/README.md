# 编辑区可访问名称(对齐 VSCode 编辑器名称,WCAG 4.1.2)

行为契约:**编辑区的文本框(role=textbox)都有可访问名称,读屏进入编辑器时念出「<文件名>，编辑器」。**
VSCode 编辑器文本区名称是「<文件名>, Editor Group N」;Continuo 不区分编辑器组,取「<文件名>，编辑器」三语。
修复前 `.cm-content` 与 `.ProseMirror` 名称为空(axe serious `aria-input-field-name`)。

## 行为

- 代码文件与 Markdown 源码模式(CodeMirror `.cm-content`):`aria-label` =「<basename>，编辑器」(en `<name>, Editor`,
  ko `<name>, 편집기`);无文件名退回「编辑器」。名称放在 Compartment 里:改名(文件名变)或切换界面语言时就地
  reconfigure,不重建编辑器。
- Markdown 编辑 / 预览(Milkdown 的 ProseMirror 根 `.ProseMirror`):同一名称,经 `editorViewOptions.attributes` 设置;
  语言切换随 Provider 的 locale key 重挂,改名随 tab id 变化重挂,创建时取当前值。
- Markdown 代码块内嵌的 CodeMirror(Crepe CodeMirror 特性,同为 role=textbox):名称「代码块」(`Code block` / `코드 블록`)。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/codemirror-phrases.ts` | `editorContentLabel(fileName)` 名称、`codeMirrorContentLabel(label)` CodeMirror contentAttributes 扩展 |
| `src/panels/Editor/CodeEditor.tsx` | 名称 Compartment,文件名 / 语言变化 reconfigure |
| `src/panels/Editor/MilkdownEditor.tsx` | `fileName` prop → ProseMirror attributes;代码块 extensions 带名称 |
| `src/panels/Editor/EditorPanel.tsx` | 把 `activeTab.filePath` 传给 MilkdownEditor |
| `electron/shared/i18n-locales/{en,zh,ko}.ts` | `editor.aria.content` / `editor.aria.code_block` |

## Specs

- `editor-accessible-name.spec.tsx`(CodeMirror 真实实例 + 真实 Crepe)
