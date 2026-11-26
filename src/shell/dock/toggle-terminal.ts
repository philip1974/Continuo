// ⌃` 切换终端(VSCode workbench.action.terminal.toggleTerminal;作用于触发它的窗口,见 getCommandDocument):
// - 焦点在该窗口的终端里 → 回到该窗口的活动编辑器(编辑器组面板激活并获焦;该窗口没有编辑器组 → 不动);
// - 否则 → 该窗口最近使用的终端激活并获焦;该窗口没有终端 → 主窗新建一个(createUserTerminal,新建后获焦);popout 子窗里
//   没有终端时不新建(新终端会画在主窗,焦点却留在子窗)。
// BDD: src/__tests__/terminal-toggle/

import type { IDockviewPanel } from 'dockview-react';
import { getDockApi } from './dock-api-ref';
import { activePanelInDocument, editorGroupInDocument, mostRecentPanelInDocument } from './group-mru';
import { getCommandDocument } from './popout-documents';
import { activateDockPanel } from './wrap-panel-close';
import { focusPanelContentWhenReady } from './panel-focus';
import { createUserTerminal } from './create-user-terminal';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { useEditorStore } from '@/stores/editor.store';

const isTerminalPanel = (panel: IDockviewPanel): boolean => panel.view?.contentComponent === TERMINAL_PANEL_TYPE;

export async function toggleTerminal(): Promise<void> {
  const api = getDockApi();
  if (!api) return;
  const doc = getCommandDocument();
  const active = activePanelInDocument(api, doc);
  const focusInTerminal =
    active !== undefined && isTerminalPanel(active) && active.view.content.element.contains(doc.activeElement);
  if (focusInTerminal) {
    const groupId = editorGroupInDocument(api, doc, useEditorStore.getState().activeGroupId);
    const editor = groupId === undefined ? undefined : api.getPanel(groupId);
    if (!editor) return;
    activateDockPanel(editor);
    focusPanelContentWhenReady(editor, () => editor.api.isActive);
    return;
  }
  const terminal = mostRecentPanelInDocument(api, doc, isTerminalPanel);
  if (terminal) {
    activateDockPanel(terminal);
    focusPanelContentWhenReady(terminal, () => terminal.api.isActive);
    return;
  }
  if (doc === document) await createUserTerminal();
}
