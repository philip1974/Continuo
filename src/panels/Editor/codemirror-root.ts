// CodeMirror 视图按所在文档重绑 root(见 editor-root-registry.ts)。CodeEditor 与 Milkdown 正文里的
// CodeMirror 代码块(Crepe 创建时取 ProseMirror 的 root)共用。
import { EditorView } from '@codemirror/view';

/**
 * 内部 API(@codemirror/view 6.x 的 DOMObserver):缓存「上次写入 / 读到的 DOM 选区」。`setRoot` 不清它;公开 API 无清除手段
 *(blur 时 CodeMirror 自己清)。
 */
interface SelectionCacheView {
  readonly observer?: { clearSelectionRange?: () => void };
}

/**
 * `scope` 内(含自身)每个 CodeMirror 视图:root 不是其 DOM 当前所在文档则 setRoot(幂等),并清掉 DOM 选区缓存。
 * 缓存里的节点随面板移进另一文档后与 state 选区仍「等价」,focus 时 CodeMirror 便不把选区写进新文档;新文档随后报告的
 * 默认起点选区会覆盖 state(光标回到第 1 行,接着输入插到文件开头)。清掉后下次同步按 state 重写。
 * BDD: src/__tests__/editor-popout-root/
 */
export function rebindCodeMirrorRoots(scope: Element): void {
  const els = [...scope.querySelectorAll<HTMLElement>('.cm-editor')];
  if (scope.matches('.cm-editor')) els.push(scope as HTMLElement);
  for (const el of els) {
    const view = EditorView.findFromDOM(el);
    if (!view || view.root === el.ownerDocument) continue;
    view.setRoot(el.ownerDocument);
    (view as unknown as SelectionCacheView).observer?.clearSelectionRange?.();
    // 移动落定前焦点已进了新文档里的编辑器(此前按旧文档判定不归它管、没写选区)→ 现在按 state 写(已获焦再 focus 不动焦点)
    if (view.root.activeElement === view.contentDOM) view.focus();
  }
}
