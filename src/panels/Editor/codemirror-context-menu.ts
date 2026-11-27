// 代码编辑器右键:在所在文档(主窗 / popout 子窗)的 <html> 上标记「这是代码编辑器的右键」,main 据此在原生编辑菜单里追加
// 更改所有匹配项 / 格式化文档(JSON)/ 命令面板(见 electron/shared/editor-context-menu)。下一次任意右键开始时清掉未被 main
// 取走的标记(右键被别处 preventDefault、没有原生菜单时),不会串到之后在输入框上的右键。
// BDD: src/__tests__/edit-context-menu/

import { EditorView } from '@codemirror/view';
import { EDITOR_CONTEXT_MENU_ATTR, type EditorContextMenuKind } from '../../../electron/shared/editor-context-menu';
import { languageIdOf } from './codemirror-language-commands';

/** 右键时的菜单种类:有格式化程序(JSON)→ code-format,否则 code。 */
export function editorContextMenuKind(view: EditorView): EditorContextMenuKind {
  return languageIdOf(view) === 'json' && !view.state.readOnly ? 'code-format' : 'code';
}

export const codeEditorContextMenuMarker = EditorView.domEventObservers({
  contextmenu(event, view) {
    if (event.defaultPrevented) return;
    const doc = view.dom.ownerDocument;
    const root = doc.documentElement;
    root.setAttribute(EDITOR_CONTEXT_MENU_ATTR, editorContextMenuKind(view));
    // 本次事件的捕获阶段已过:这个监听只在下一次右键开始时触发
    doc.defaultView?.addEventListener('contextmenu', () => root.removeAttribute(EDITOR_CONTEXT_MENU_ATTR), {
      capture: true,
      once: true,
    });
  },
});
