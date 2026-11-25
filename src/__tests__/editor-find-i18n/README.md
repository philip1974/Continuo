# 编辑器查找面板随界面语言(对齐 VSCode 查找控件)

行为契约:**编辑器 ⌘F 查找 / 替换面板(及跳转行、折叠提示)随界面语言显示,外观与设计层一致(对齐 VSCode 查找控件)。**

## 行为

- CodeEditor(代码文件 + Markdown Source)与 Markdown 编辑模式代码块(Crepe 的 CodeMirror,同样带 basicSetup 查找面板)
  都注入 `EditorState.phrases`:查找 / 替换输入框占位、下一个 / 上一个 / 全部 / 区分大小写 / 正则表达式 / 全字匹配 /
  替换 / 全部替换 / 关闭、跳转行、读屏播报、折叠提示按 en / zh / ko catalog(`editor.cm.*`)显示。
- 映射覆盖 `@codemirror/search` 源码里调用的全部 phrase(规范从已安装包源码收集核对,升级新增文案即失败)。
- 切换界面语言:CodeEditor 经 Compartment reconfigure(不重建编辑器),下次打开面板即新语言;Markdown 编辑器随 locale 重挂。
- 面板外观走 token:输入框同 design `Input`(`--md-surface-container-low` 底 + `--md-outline-variant` 描边,聚焦 `--md-focus-ring`),
  按钮同 design 次级按钮(token 底 / 描边 / hover state layer),复选框 `accent-color: var(--md-primary)`,键盘焦点环;亮 / 暗共用。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/codemirror-phrases.ts` | CodeMirror 原文 → catalog key 映射,按当前语言生成 phrases 扩展 |
| `src/panels/Editor/CodeEditor.tsx` | phrases 放进 Compartment,语言切换时 reconfigure |
| `src/panels/Editor/MilkdownEditor.tsx` | Crepe CodeMirror 特性 `extensions: [codeMirrorPhrases()]` |
| `src/panels/Editor/code-editor-theme.ts` | `.cm-panel` / `.cm-textfield` / `.cm-button` / 复选框 token 样式 |

## Specs

- `editor-find-i18n.spec.tsx`
- 代码块部分:`../editor-milkdown-chrome-i18n/milkdown-chrome-i18n.spec.tsx`
