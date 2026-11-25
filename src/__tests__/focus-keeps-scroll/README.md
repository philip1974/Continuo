# 聚焦不把视口拉到光标处(VSCode 对齐)

VSCode 切回某个编辑器、重启恢复会话时,恢复的是保存时的视口(滚动位置)与选区,随后编辑器获焦**不会**把视口拉到光标处
(光标可以在视口外)。Continuo 在多个入口把焦点交给编辑区 / 面板内容:点编辑器 tab、点 dock tab / F6 / 关闭后回落、
重启恢复后聚焦活动编辑器、打开文件后聚焦。

## 问题根因

这些入口此前对可编辑区直接调 DOM `focus()`。对 ProseMirror(Markdown 编辑模式)而言:Chromium 把 DOM 选区放到文档开头,
ProseMirror 的 DOM 观察(`DOMObserver.flush`)在「刚聚焦、不是鼠标点进来、DOM 选区在文档开头」时认定是聚焦重置了选区,
改回自己的选区并 `scrollToSelection()` —— 切 tab 回来 / 重启后刚恢复的滚动位置(如 1056)随即被拉回光标处(如 56),
新值又被存回缓存与 `explorer.json`。`preventScroll` 挡不住(滚动是 ProseMirror 自己设的)。经 `view.focus()` 聚焦则会先
同步 DOM 选区并记为当前选区,不走这条路。源码模式(CodeMirror)不受影响。

## 契约(`src/lib/content-focus-target.ts`)

- `setContentFocusHandler(el, focus)`:编辑器视图就绪时把自己的聚焦方式登记到其可编辑 DOM(Milkdown:`view.focus()`,
  只读预览为 `dom.focus({ preventScroll: true })`);返回注销函数(只注销自己那份)。
- `focusContentTarget(el)`:登记了 → 用它;否则 `el.focus({ preventScroll: true })`。
- 以下入口一律经 `focusContentTarget` 聚焦落点:
  - `focusPanelContent`(点 dock tab、F6、关组 / 关面板后回落)
  - `focusActiveEditorAfterRestore`(重启恢复后聚焦活动编辑器)
  - EditorHeader 鼠标点 tab 后聚焦编辑区
- 打开文件后聚焦(`editor-focus-registry`)本来就走 `view.focus()`。

## 滚动记录(`editor-view-state` 的 Milkdown 部分)

- 恢复滚动位置期间(设值到下一帧补齐为止)的滚动事件不记进缓存:中间值(内容尚未撑开被夹小等)不覆盖要恢复的值。

## 端到端

- `tests/e2e/markdown-edit-scroll-restore.spec.ts`:Markdown 编辑模式滚到中段、光标在开头 → 切到别的 tab 再切回 /
  重启(两次)→ 滚动位置保持且焦点在编辑区。
