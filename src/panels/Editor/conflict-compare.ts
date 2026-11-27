// 保存冲突「比较」(VSCode textFileSaveErrorHandler:ResolveSaveConflictAction 打开「{file} (in file) ↔ {file} (in Code)」
// 差异编辑器;编辑器标题栏 acceptLocalChanges「Use your changes and overwrite file contents」/ revertLocalChanges「Discard your
// changes and revert to file contents」执行后回到原编辑器并关闭差异编辑器)。
//
// 差异 tab 是一个 dock 面板(同设置页),落在原编辑器组所在的 dock 组里;右侧「你的版本」就是 store 里的同一文档(不复制),
// 编辑即改原 tab。本模块只依赖 store / dock api,不引入差异视图(@codemirror/merge 在 ConflictDiffPanel 的懒加载 chunk 里)。
// BDD: src/__tests__/editor-save-conflict-compare/

import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { editorGroupIdsOf, groupTabsOf, useEditorStore } from '@/stores/editor.store';
import { addPanelAndFocus, getDockApi, revealDockPanel, runWhenDockLayoutReady } from '@/shell/dock/dock-api-ref';
import { activateDockPanel } from '@/shell/dock/wrap-panel-close';
import { activePanelInDocument } from '@/shell/dock/group-mru';
import { getCommandDocument } from '@/shell/dock/popout-documents';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { t } from '@/i18n';
import { basename } from '@/lib/path-cross';
import { basenameForChrome } from '@/lib/path-label';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import { notifySaveFailed } from '@/notifications/notify-open-failed';
import { revertFile, saveFile, type EditorFileDeps } from './editor-file-actions';
import { editorFileDeps } from './editor-file-deps';
import { findEditorFileTabById } from './editor-tab-lookup';
import { flushEditorWriteBacks } from './editor-writeback-registry';
import { requestEditorFocus } from './editor-focus-registry';
import {
  CONFLICT_DIFF_PANEL_TYPE,
  CONFLICT_DIFF_TITLE_KEY,
  conflictDiffPanelId,
  conflictDiffParamsOf,
  type ConflictDiffParams,
} from './conflict-diff-constants';

/** VSCode 同名命令 id(workbench.files.action.acceptLocalChanges / revertLocalChanges)。 */
export const ACCEPT_LOCAL_CHANGES_COMMAND_ID = 'workbench.files.action.acceptLocalChanges';
export const REVERT_LOCAL_CHANGES_COMMAND_ID = 'workbench.files.action.revertLocalChanges';

export type ConflictResolution = 'accept' | 'revert';

/**
 * 打开(或激活已有的)差异 tab:左 = 磁盘当前内容,右 = tabId 文档(你的版本)。落在 groupId 编辑器组面板所在的 dock 组
 *(同组新 tab;组面板不在 → dock 默认落点)。dock 未就绪静默;布局待恢复排队。
 */
export function openConflictCompare(tabId: string, groupId: string): void {
  runWhenDockLayoutReady((api) => {
    const tab = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
    if (!tab) return;
    const id = conflictDiffPanelId(tabId);
    const existing = api.getPanel(id);
    if (existing) {
      revealDockPanel(api, existing);
      return;
    }
    const name = basename(tab.filePath);
    const params: ConflictDiffParams = { tabId, groupId, titleKey: CONFLICT_DIFF_TITLE_KEY, titleArgs: { name } };
    const reference = api.getPanel(groupId);
    addPanelAndFocus(api, {
      id,
      component: CONFLICT_DIFF_PANEL_TYPE,
      title: t(CONFLICT_DIFF_TITLE_KEY, { name }),
      params,
      ...(reference ? { position: { referencePanel: reference, direction: 'within' as const } } : {}),
    });
    ensureAutoClose(api);
  });
}

/** 已打开的差异 tab(全部窗口)。 */
function conflictDiffPanels(api: Pick<DockviewApi, 'panels'>): IDockviewPanel[] {
  return api.panels.filter((p) => conflictDiffParamsOf(p) !== null);
}

// 原 tab 关闭(或改名:tab id 随路径变)→ 文档已不在,差异 tab 随之关闭(VSCode 的差异编辑器引用的模型随之销毁)。
// 有差异 tab 时才订阅 store;最后一个关掉后退订。
let autoClose: { readonly api: DockviewApi; readonly dispose: () => void } | null = null;

function ensureAutoClose(api: DockviewApi): void {
  if (autoClose?.api === api) return;
  autoClose?.dispose();
  const check = (): void => {
    const panels = conflictDiffPanels(api);
    if (panels.length === 0) {
      autoClose?.dispose();
      return;
    }
    const tabs = useEditorStore.getState().tabs;
    for (const panel of panels) {
      const params = conflictDiffParamsOf(panel)!;
      if (!findEditorFileTabById(tabs, params.tabId)) panel.api.close();
    }
  };
  const unsubStore = useEditorStore.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) check();
  });
  const removeSub = api.onDidRemovePanel(() => {
    if (conflictDiffPanels(api).length === 0) autoClose?.dispose();
  });
  const handle = {
    api,
    dispose: () => {
      unsubStore();
      removeSub.dispose();
      if (autoClose === handle) autoClose = null;
    },
  };
  autoClose = handle;
}

/** 关闭 tabId 的差异 tab(若开着)。 */
function closeConflictCompare(api: DockviewApi, tabId: string): void {
  api.getPanel(conflictDiffPanelId(tabId))?.api.close();
}

/** 回到原 tab:优先打开差异 tab 时的编辑器组,文档已不在该组 → 任一含它的组;激活组面板并聚焦编辑器(VSCode reopen original editor)。 */
function revealOriginalEditor(api: DockviewApi, tabId: string, groupId: string): void {
  const s = useEditorStore.getState();
  const inGroup = (g: string): boolean => groupTabsOf(s, g).some((tab) => tab.id === tabId);
  const target = inGroup(groupId) ? groupId : editorGroupIdsOf(s).find(inGroup);
  if (target === undefined) return;
  s.switchTab(tabId, { groupId: target });
  const panel = api.getPanel(target);
  if (panel) activateDockPanel(panel);
  requestEditorFocus(tabId, target);
}

/**
 * 接受我的版本(覆盖磁盘,不再比较)/ 使用磁盘版本(放弃我的更改)。成功 → 关闭差异 tab、回到原 tab,返回 true;失败 → 按 code
 * 提示,差异 tab 保留(可重试或改选另一项),返回 false。
 */
export async function resolveConflict(
  tabId: string,
  groupId: string,
  choice: ConflictResolution,
  deps: EditorFileDeps = editorFileDeps,
): Promise<boolean> {
  const tab = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
  if (!tab) return false;
  try {
    // 原 tab 若是 Milkdown,尚未上抛的输入先回写(接受时一并写盘;放弃时也不让卸载回写把丢弃的输入写回)
    flushEditorWriteBacks([tabId]);
    const r =
      choice === 'accept' ? await saveFile(tabId, deps, { force: true }) : await revertFile(tabId, deps);
    if (!r.ok) {
      if (choice === 'accept') notifySaveFailed(basenameForChrome(tab.filePath), r);
      else notifyFailure(r);
      return false;
    }
  } catch (err) {
    notifyThrownError(err);
    return false;
  }
  const api = getDockApi();
  if (api) {
    closeConflictCompare(api, tabId);
    revealOriginalEditor(api, tabId, groupId);
  }
  return true;
}

/** 触发命令的窗口里的活动差异 tab;不是差异 tab → null。 */
export function activeConflictDiff(): ConflictDiffParams | null {
  const api = getDockApi();
  if (!api) return null;
  const panel = activePanelInDocument(api, getCommandDocument());
  return panel ? conflictDiffParamsOf(panel) : null;
}

async function resolveActiveConflict(choice: ConflictResolution): Promise<void> {
  const active = activeConflictDiff();
  if (active) await resolveConflict(active.tabId, active.groupId, choice);
}

/** 命令面板命令(VSCode 只放在差异编辑器标题栏;这里另进命令面板)。活动面板不是差异 tab → 什么也不做。无默认键(VSCode 同)。 */
export function conflictCompareCommandSpecs(): CommandSpec[] {
  return [
    {
      id: ACCEPT_LOCAL_CHANGES_COMMAND_ID,
      title: 'Accept My Version (Overwrite File on Disk)',
      titleKey: 'commands.file.accept_local_changes.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: () => resolveActiveConflict('accept'),
    },
    {
      id: REVERT_LOCAL_CHANGES_COMMAND_ID,
      title: 'Use Disk Version (Discard My Changes)',
      titleKey: 'commands.file.revert_local_changes.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: () => resolveActiveConflict('revert'),
    },
  ];
}
