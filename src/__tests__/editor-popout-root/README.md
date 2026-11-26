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
- MilkdownEditor:ProseMirror 视图 `updateRoot()`,并把 selectionchange 监听从旧文档迁到当前文档(`updateRoot()`
  不迁移;prosemirror-view 1.42.x 的 `DOMObserver` 按调用时 `dom.ownerDocument` 挂 / 移,公开 API 无迁移手段,
  故用内部 `domObserver.onSelectionChange` / `connectSelection()`;DOM 移走后拿不到旧文档,挂载时与每次重绑后记下);
  否则旧文档永远持有已销毁视图,且弹出后首次事务前纯鼠标改选区不进 state。正文里的 CodeMirror 代码块
  (Crepe CodeMirror 特性,创建时取 ProseMirror 的 root)同样 `setRoot`。
- 光标 / 选区不变(VSCode Move Editor Group into New Window 同):CodeMirror 缓存「上次写入 / 读到的 DOM 选区」,
  节点随面板移进另一文档后缓存仍与 state「等价」,获焦时便不把选区写进新文档,新文档随后报告的默认起点选区会覆盖
  state(光标回到第 1 行、输入插到文件开头)。重绑时清掉该缓存(内部 `observer.clearSelectionRange()`;blur 时
  CodeMirror 自己也清),此后获焦按 state 写选区;重绑时焦点已在新文档里的编辑器 → 立即按 state 写。弹出、收回、
  多次往返同理。ProseMirror 每次按实时 DOM 选区比较,不受影响。
- 重绑幂等:root 已是当前文档则不动;引擎挂载时也按当前文档对齐一次(覆盖「创建时面板 DOM 尚未进子窗」)。
- 不重挂编辑器:不丢未保存输入、光标、撤销历史。
- 弹出与收回(popout → grid)同一路径,往返后 root 回到主窗文档。

## 已知边界

- 监听迁移依赖 prosemirror-view 内部 `DOMObserver` API(1.42.x);升级 prosemirror-view 时由本规范的
  selectionchange 迁移用例守护。

## 规范

- `editor-popout-root.spec.tsx`:真实 CodeMirror / Crepe,把面板 DOM 移进 iframe 子文档后触发 location 变化。
