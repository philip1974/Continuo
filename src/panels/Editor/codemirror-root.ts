// CodeMirror 视图按所在文档重绑 root(见 editor-root-registry.ts)。CodeEditor 与 Milkdown 正文里的
// CodeMirror 代码块(Crepe 创建时取 ProseMirror 的 root)共用。
import { EditorView } from '@codemirror/view';

/** `scope` 内(含自身)每个 CodeMirror 视图:root 不是其 DOM 当前所在文档则 setRoot(幂等)。 */
export function rebindCodeMirrorRoots(scope: Element): void {
  const els = [...scope.querySelectorAll<HTMLElement>('.cm-editor')];
  if (scope.matches('.cm-editor')) els.push(scope as HTMLElement);
  for (const el of els) {
    const view = EditorView.findFromDOM(el);
    if (view && view.root !== el.ownerDocument) view.setRoot(el.ownerDocument);
  }
}
