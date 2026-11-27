// 代码编辑器右键:在所在文档(主窗 / popout 子窗)的 <html> 上标记「这是代码编辑器的右键」,main 据此在原生编辑菜单里追加
// 转到定义(TS / JS,有语言服务)/ 更改所有匹配项 / 格式化文档(JSON)/ 命令面板(见 electron/shared/editor-context-menu)。下一次任意右键开始时清掉未被 main
// 取走的标记(右键被别处 preventDefault、没有原生菜单时),不会串到之后在输入框上的右键。
// BDD: src/__tests__/edit-context-menu/

import { EditorView } from '@codemirror/view';
import { EDITOR_CONTEXT_MENU_ATTR, type EditorContextMenuKind } from '../../../electron/shared/editor-context-menu';
import { languageIdOf } from './codemirror-language-commands';
import { supportsGoToDefinition } from './codemirror-go-to-definition';

/** 右键时的菜单种类:有格式化程序(JSON)→ code-format;有转到定义(TS / JS)→ code-definition;否则 code。 */
export function editorContextMenuKind(view: EditorView): EditorContextMenuKind {
  if (languageIdOf(view) === 'json' && !view.state.readOnly) return 'code-format';
  return supportsGoToDefinition(view) ? 'code-definition' : 'code';
}

/**
 * 右键位置不在任何选区内 → 光标移到右键处(VSCode 编辑器右键同:菜单里的「转到定义」作用于右键处的单词)。只在有转到定义的
 * 编辑器上这样做(其它编辑器的菜单项不依赖光标位置,保持原行为)。
 */
function moveCursorToContextMenuPosition(event: MouseEvent, view: EditorView): void {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return;
  if (view.state.selection.ranges.some((r) => r.from <= pos && pos <= r.to)) return;
  view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' });
}

export const codeEditorContextMenuMarker = EditorView.domEventObservers({
  contextmenu(event, view) {
    if (event.defaultPrevented) return;
    const doc = view.dom.ownerDocument;
    const root = doc.documentElement;
    const kind = editorContextMenuKind(view);
    if (kind === 'code-definition') moveCursorToContextMenuPosition(event, view);
    root.setAttribute(EDITOR_CONTEXT_MENU_ATTR, kind);
    // 本次事件的捕获阶段已过:这个监听只在下一次右键开始时触发
    doc.defaultView?.addEventListener('contextmenu', () => root.removeAttribute(EDITOR_CONTEXT_MENU_ATTR), {
      capture: true,
      once: true,
    });
  },
});
