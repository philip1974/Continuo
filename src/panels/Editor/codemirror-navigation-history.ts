// CodeMirror 选区变化 → 导航历史(后退 / 前进的光标记录;是否记录、记几条由 navigation-history 判定)。
// BDD: src/__tests__/editor-navigation-history/

import { EditorView } from '@codemirror/view';
import { Transaction, type Extension } from '@codemirror/state';
import { navigationSelectionOf, notifyEditorSelection } from './navigation-history';

/**
 * 编辑器组 groupId 里 tab tabId 的视图:每次选区变化通知导航历史(带变化前的光标;事务都没有 userEvent → 程序化定位,
 * 如 scrollToLine 打开到某行)。
 */
export function navigationHistoryExtension(tabId: string, groupId: string): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.selectionSet) return;
    notifyEditorSelection(
      groupId,
      tabId,
      navigationSelectionOf(update.state.doc, update.state.selection),
      navigationSelectionOf(update.startState.doc, update.startState.selection),
      update.transactions.every((tr) => tr.annotation(Transaction.userEvent) === undefined),
    );
  });
}
