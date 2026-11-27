// workbench.action.reopenClosedEditor(⇧⌘T):重新打开最近关闭的编辑器(对齐 VSCode HistoryService.reopenLastClosedEditor)。
// 取栈顶:原编辑器组还在 → 回原组,否则落到活动组(popout 子窗里触发 → 落在该子窗里,见 targetOf);按关闭时的位置插回、
// 激活并聚焦;视图状态经跨重启恢复的回填还原。
// 目标组已打开该文件 / 文件读不到 → 跳过这条取下一条(VSCode 同,不提示)。BDD: src/__tests__/editor-reopen-closed/

import {
  beginUserActivation,
  createTab,
  editorGroupIdsOf,
  getUserActivationGen,
  groupTabsOf,
  withEncoding,
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
import type { DockviewGroupPanel } from 'dockview-react';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { editorGroupInDocument, popoutGroupOfDocument } from '@/shell/dock/group-mru';
import { getCommandDocument } from '@/shell/dock/popout-documents';
import { editorGroupForOpen } from './editor-open-group';
import { tWithFallback } from '@/i18n/translate';
import { nextEditorGroupId } from '../../../electron/shared/editor-group-id';

/** 重新打开栈顶的已关闭编辑器(跳过已打开 / 读不到的);重新打开了一个 → true,栈里没有可开的 → false。 */
export async function reopenClosedEditor(deps: EditorFileDeps = editorFileDeps): Promise<boolean> {
  // 触发窗口在第一个 await 前读出(之后不再是热键分发的同步上下文)
  const doc = getCommandDocument();
  for (let entry = popRecentlyClosedEditor(); entry; entry = popRecentlyClosedEditor()) {
    if (await reopenEntry(entry, deps, doc)) return true;
  }
  return false;
}

/** 目标:已有的编辑器组,或在 popout 子窗的这个 dock 组里 / 主窗('main')新建一个编辑器组。 */
type ReopenTarget = { readonly groupId: string } | { readonly createIn: DockviewGroupPanel | 'main' };

/**
 * 主窗里触发:原组还在 → 原组;否则活动组。popout 子窗里触发(⇧⌘T 在子窗分发;按触发窗口判断,不看全局活动面板 ——
 * 点标题栏切窗口不改活动组)→ 落在该子窗(VSCode:辅助窗口里重开落到该窗口的编辑器组;否则在主窗打开而子窗毫无反馈,
 * renderer 也无激活主窗的通路):原组在该子窗 → 原组;否则子窗里的编辑器组(活动组优先);子窗里没有编辑器组 → 在子窗里
 * 新建一个(同子窗里拆分)。
 */
function targetOf(entry: RecentlyClosedEditor, doc: Document): ReopenTarget {
  const s = useEditorStore.getState();
  const groups = editorGroupIdsOf(s);
  const api = getDockApi();
  const popout = api && doc !== document ? popoutGroupOfDocument(api, doc) : undefined;
  if (api && popout) {
    const here = groups.filter((id) => api.getPanel(id)?.group === popout);
    const pick = [entry.groupId, s.activeGroupId].find((id) => here.includes(id)) ?? here[0];
    return pick !== undefined ? { groupId: pick } : { createIn: popout };
  }
  if (groups.includes(entry.groupId)) return { groupId: entry.groupId };
  // 原组已不在 → 主窗的编辑器组(活动编辑器组可能在子窗:从子窗切回主窗时它仍停在子窗);主窗没有编辑器组而活动编辑器组
  // 在子窗 → 在主窗新建一个(同打开文件,见 editor-open-group;VSCode 主窗总保留一个编辑器组)
  const main = api ? editorGroupInDocument(api, document, s.activeGroupId) : undefined;
  if (main !== undefined) return { groupId: main };
  return api?.getPanel(s.activeGroupId)?.api.location.type === 'popout' ? { createIn: 'main' } : { groupId: s.activeGroupId };
}

function openInTargetGroup(entry: RecentlyClosedEditor, doc: Document): boolean {
  const target = targetOf(entry, doc);
  if (!('groupId' in target)) return false;
  return groupTabsOf(useEditorStore.getState(), target.groupId).some((t) => pathEquals(t.filePath, entry.path));
}

/** 在 popout 子窗的 dock 组里新建空编辑器组(同一 dock 组里的另一个面板,同子窗里拆分)/ 在主窗新建;组数已达上限 → null。 */
function createGroupIn(group: DockviewGroupPanel | 'main'): string | null {
  if (group === 'main') return editorGroupForOpen(document) ?? null;
  const api = getDockApi();
  if (!api) return null;
  const s = useEditorStore.getState();
  const id = nextEditorGroupId([...editorGroupIdsOf(s), ...api.panels.map((p) => p.id)]);
  if (!s.splitGroup(s.activeGroupId, id, null)) return null;
  api.addPanel({
    id,
    component: 'editor',
    title: tWithFallback('panels.editor.title', 'Editor'),
    params: { titleKey: 'panels.editor.title' },
    position: { referenceGroup: group },
  });
  return id;
}

async function reopenEntry(entry: RecentlyClosedEditor, deps: EditorFileDeps, doc: Document): Promise<boolean> {
  if (openInTargetGroup(entry, doc)) return false;
  const store = useEditorStore;
  // 文档已在别的组打开 → 在目标组再打开它(共享同一文档,不重新读盘)
  let tab: EditorTab | null = findEditorFileTabByPath(store.getState().tabs, entry.path);
  let latest = true;
  if (!tab) {
    // 用户激活代际(同 openFileByPath):读盘期间用户又打开 / 切到别的文件 → 只在后台插回,不抢激活与焦点
    const my = beginUserActivation();
    let r;
    try {
      r = await (entry.encoding === undefined
        ? deps.fs.readFile(entry.path)
        : deps.fs.readFile(entry.path, { encoding: entry.encoding }));
    } catch {
      return false;
    }
    if (!r.ok) return false;
    latest = my === getUserActivationGen();
    if (openInTargetGroup(entry, doc)) return false;
    tab = findEditorFileTabByPath(store.getState().tabs, entry.path);
    if (!tab) {
      const created = createTab(entry.path, r.data, r.realPath, r.encoding);
      tab = entry.encoding === undefined ? created : withEncoding(created, created.encoding ?? 'utf8', true);
    }
  }
  const id = tab.id;
  const target = targetOf(entry, doc);
  // 读盘期间用户已切走(只在后台插回)→ 不为此新建组(会抢激活),落到活动组
  const created = 'groupId' in target || !latest ? null : createGroupIn(target.createIn);
  const groupId = 'groupId' in target ? target.groupId : (created ?? useEditorStore.getState().activeGroupId);
  // 关闭时的视图状态回填到重新打开它的组(视图状态按组 + 文件,不影响该文件在别的组里的视图;BDD: src/__tests__/editor-view-state-groups/)
  if (entry.viewState) seedPersistedEditorViewState(id, entry.viewState, groupId);
  const where = { groupId, index: entry.index };
  store.getState().openTab(tab, latest ? where : { ...where, activate: false, requestFocus: false });
  // openTab 可能拒开(tab 数 / 路径长度上限)
  if (!groupTabsOf(store.getState(), groupId).some((t) => t.id === id)) return false;
  if (latest) requestEditorFocus(id, groupId);
  return true;
}
