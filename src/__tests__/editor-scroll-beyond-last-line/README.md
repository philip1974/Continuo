# 滚动超过最后一行(editor.scrollBeyondLastLine)

此前代码编辑器滚到底时最后一行贴在视口底部,无法再往下滚。VSCode `editor.scrollBeyondLastLine` 默认 `true`:可以一直滚到最后一行
位于视口顶部(内容底部多出「视口高度 − 一行」的空白)。VSCode 对 Markdown 没有语言级覆盖(markdown-basics 的
`configurationDefaults` 不含此项),Markdown 源码模式同样生效。

1. **默认开**:代码编辑器与 Markdown 源码模式挂 CodeMirror `scrollPastEnd()`(内容区底部留出一屏减一行的空白)。
2. **设置 `editor.scrollBeyondLastLine`**(编辑器 → 外观,布尔,默认开;三语标题 / 说明,说明照抄 VSCode 本地化
   「Controls whether the editor will scroll beyond the last line.」/「控制编辑器是否可以滚动到最后一行之后。」/
   「편집기에서 마지막 줄 이후로 스크롤할지 여부를 제어합니다.」)。
3. **改设置即时生效**(Compartment 重配置,不重建编辑器、不丢光标 / 撤销历史)。
4. Markdown 编辑 / 预览模式(Milkdown)不涉及(不是行编辑器)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/core-setting-specs.ts` | `EDITOR_SCROLL_BEYOND_LAST_LINE` |
| `src/core-plugins/EditorTabPlugin.ts` | 注册设置项 |
| `src/panels/Editor/CodeEditor.tsx` | `scrollPastEnd()` 挂载与热切 |

## 规范

- `scroll-beyond-last-line.spec.tsx`:默认开、关掉后去掉底部空白、再开恢复、设置项注册与三语文案
- e2e `tests/e2e/editor-scroll-beyond-last-line.spec.ts`:真实鼠标滚轮滚到底,最后一行到达视口顶部;关掉设置后不能
