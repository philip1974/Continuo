// CodeMirror 选区变化 → 导航历史(后退 / 前进的光标记录;是否记录、记几条由 navigation-history 判定)。
// BDD: src/__tests__/editor-navigation-history/

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { navigationSelectionOf, notifyEditorSelection } from './navigation-history';

/** 编辑器组 groupId 里 tab tabId 的视图:每次选区变化通知导航历史(带变化前的光标)。 */
export function navigationHistoryExtension(tabId: string, groupId: string): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.selectionSet) return;
    notifyEditorSelection(
      groupId,
      tabId,
      navigationSelectionOf(update.state.doc, update.state.selection),
      navigationSelectionOf(update.startState.doc, update.startState.selection),
    );
  });
}
