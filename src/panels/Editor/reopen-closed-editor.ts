// workbench.action.reopenClosedEditor(⇧⌘T):重新打开最近关闭的编辑器(对齐 VSCode HistoryService.reopenLastClosedEditor)。
// 取栈顶:原编辑器组还在 → 回原组,否则落到活动组;按关闭时的位置插回、激活并聚焦;视图状态经跨重启恢复的回填还原。
// 目标组已打开该文件 / 文件读不到 → 跳过这条取下一条(VSCode 同,不提示)。BDD: src/__tests__/editor-reopen-closed/

import {
  beginUserActivation,
  createTab,
  editorGroupIdsOf,
  getUserActivationGen,
  groupTabsOf,
  useEditorStore,
  type EditorTab,
} from '@/stores/editor.store';
import { pathEquals } from '@/lib/path-cross';
import type { EditorFileDeps } from './editor-file-actions';
import { editorFileDeps } from './editor-file-deps';
import { findEditorFileTabByPath } from './editor-tab-lookup';
import { seedPersistedEditorViewState } from './editor-view-state-cache';
import { requestEditorFocus } from './editor-focus-registry';
import { popRecentlyClosedEditor, type RecentlyClosedEditor } from './recently-closed-editors';

/** 重新打开栈顶的已关闭编辑器(跳过已打开 / 读不到的);重新打开了一个 → true,栈里没有可开的 → false。 */
export async function reopenClosedEditor(deps: EditorFileDeps = editorFileDeps): Promise<boolean> {
  for (let entry = popRecentlyClosedEditor(); entry; entry = popRecentlyClosedEditor()) {
    if (await reopenEntry(entry, deps)) return true;
  }
  return false;
}

/** 目标组:原组还在 → 原组;否则活动组。 */
function targetGroupOf(entry: RecentlyClosedEditor): string {
  const s = useEditorStore.getState();
  return editorGroupIdsOf(s).includes(entry.groupId) ? entry.groupId : s.activeGroupId;
}

function openInTargetGroup(entry: RecentlyClosedEditor): boolean {
  const s = useEditorStore.getState();
  return groupTabsOf(s, targetGroupOf(entry)).some((t) => pathEquals(t.filePath, entry.path));
}

async function reopenEntry(entry: RecentlyClosedEditor, deps: EditorFileDeps): Promise<boolean> {
  if (openInTargetGroup(entry)) return false;
  const store = useEditorStore;
  // 文档已在别的组打开 → 在目标组再打开它(共享同一文档,不重新读盘)
  let tab: EditorTab | null = findEditorFileTabByPath(store.getState().tabs, entry.path);
  let latest = true;
  if (!tab) {
    // 用户激活代际(同 openFileByPath):读盘期间用户又打开 / 切到别的文件 → 只在后台插回,不抢激活与焦点
    const my = beginUserActivation();
    let r;
    try {
      r = await deps.fs.readFile(entry.path);
    } catch {
      return false;
    }
    if (!r.ok) return false;
    latest = my === getUserActivationGen();
    if (openInTargetGroup(entry)) return false;
    tab = findEditorFileTabByPath(store.getState().tabs, entry.path);
    if (!tab) {
      tab = createTab(entry.path, r.data, r.realPath);
      if (entry.viewState) seedPersistedEditorViewState(tab.id, entry.viewState);
    }
  }
  const id = tab.id;
  const groupId = targetGroupOf(entry);
  const where = { groupId, index: entry.index };
  store.getState().openTab(tab, latest ? where : { ...where, activate: false, requestFocus: false });
  // openTab 可能拒开(tab 数 / 路径长度上限)
  if (!groupTabsOf(store.getState(), groupId).some((t) => t.id === id)) return false;
  if (latest) requestEditorFocus(id, groupId);
  return true;
}
