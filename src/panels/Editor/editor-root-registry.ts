// 编辑器视图「所在文档」重绑注册表(BDD: src/__tests__/editor-popout-root/)。
//
// CodeMirror / ProseMirror 视图创建时缓存 root:选区经 getSelection(root) 读,CodeMirror 的 selectionchange
// 监听与样式也挂在该文档上。dockview 弹出 / 收回 popout 只把面板 DOM 移到另一窗口的文档、不重挂 React →
// 已挂载视图仍按原窗口文档取选区。引擎挂载时登记「按当前 ownerDocument 重绑」函数(须幂等),EditorPanel
// 在面板 location 变化落定后统一调用(同终端拖放 topic-25 的 onDidLocationChange 重绑)。
// 本文件不 import 编辑引擎:EditorPanel 静态依赖它,引擎 chunk 仍保持 lazy(perf E2)。

const rebinders = new Set<() => void>();

/** 登记重绑函数,返回注销函数。 */
export function registerEditorRootRebind(fn: () => void): () => void {
  rebinders.add(fn);
  return () => {
    rebinders.delete(fn);
  };
}

/** 让已挂载的编辑器按各自 DOM 当前的 ownerDocument 重绑 root(单个失败不影响其它)。 */
export function rebindEditorRoots(): void {
  for (const fn of [...rebinders]) {
    try {
      fn();
    } catch (err) {
      console.warn('[editor] root rebind failed', err);
    }
  }
}
