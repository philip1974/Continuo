# editor-popout-root(Editor 弹出 popout 后编辑器跟随所在文档取选区)

行为契约:**Editor 面板弹出到 popout 子窗(或收回主窗)后,已挂载的编辑器按面板当前所在文档读写选区**。

## 背景

dockview 弹出 / 收回 popout 只把面板 DOM 移到另一窗口的文档,不重挂 React。CodeMirror(`EditorView._root`)与
ProseMirror(`EditorView.root` 缓存)在创建时定下 root:选区经 `getSelection(root)` 读、CodeMirror 的
selectionchange 监听与样式也挂在该文档上。不处理时子窗里移动光标 / 输入读到的是主窗文档的选区;切 tab / 切模式
(key 变化重建视图)后才恢复。终端拖放为同一原因在 `onDidLocationChange` 后按 `ownerDocument` 重绑(topic-25)。

## 行为

- `EditorPanel` 订阅面板 `api.onDidLocationChange`,移动落定后(microtask)让当前挂载的编辑器按各自 DOM 的
  `ownerDocument` 重绑 root;面板卸载时退订。无 `api`(测试直接渲染)时不订阅。
- CodeEditor:`view.setRoot(ownerDocument)`(CodeMirror 同时迁移 selectionchange 监听窗口与样式)。
- MilkdownEditor:ProseMirror 视图 `updateRoot()`;正文里的 CodeMirror 代码块(Crepe CodeMirror 特性,创建时取
  ProseMirror 的 root)同样 `setRoot`。
- 重绑幂等:root 已是当前文档则不动;引擎挂载时也按当前文档对齐一次(覆盖「创建时面板 DOM 尚未进子窗」)。
- 不重挂编辑器:不丢未保存输入、光标、撤销历史。
- 弹出与收回(popout → grid)同一路径,往返后 root 回到主窗文档。

## 已知边界

- ProseMirror 的 selectionchange 监听挂在构造时的 `ownerDocument`,`updateRoot()` 不迁移;子窗里首个事务
  (输入 / 程序化选区更新)的 `domObserver.start()` 会按新文档重挂。此前纯鼠标改选区不进 state —— 需真机确认。

## 规范

- `editor-popout-root.spec.tsx`:真实 CodeMirror / Crepe,把面板 DOM 移进 iframe 子文档后触发 location 变化。
