// 后退 / 前进(VSCode workbench.action.navigateBack / navigateForward)。每个渲染进程一份导航栈 = 每个主窗一份,
// popout 子窗与其主窗共用(VSCode 辅助窗口与主窗共用一个 HistoryService)。只在内存,不跨重启。
// 记录(见 navigation-stack):
// - 换编辑器:editor.store 的活动编辑器(活动组 + 其活动 tab)变了,且是用户动作 —— 打开 / 切换(editorFocusPulse 递增)、
//   换活动组、原活动 tab 被关掉 / 改名;会话恢复的程序化打开(requestFocus:false)不记;
// - 光标:活动编辑器的 CodeMirror 选区变化(codemirror-navigation-history)→ notifyEditorSelection;当前这条还没有光标、
//   且这次是用户动作(点击 / 方向键 / 打字)时先按移动前的光标补上 —— 那是用户在该视图里实际停留过的位置。程序化定位
//  (搜索结果 / 终端链接 / 后退到未打开的文件等「打开到第 N 行」:视图刚挂载即 scrollToLine)不补,目标直接替换只记文件的
//   当前这条(VSCode:打开到某行只记一条,后退一次即回到来处)。
// 执行:打开 / 激活该条的文件(原组不在 → 触发窗口的编辑器组),有光标则 scrollToLine 居中并聚焦;执行期间的通知不记录。
// 文件删除 / 移动(onEditorPathChange)、切换工作区根 → 剔除 / 改写条目。
// 本模块在启动路径上(editor-commands):不静态引入编辑引擎(scrollToLine 动态 import)。
// BDD: src/__tests__/editor-navigation-history/

import { isUntitledPath } from '../../../electron/shared/untitled';
import type { EditorSelection, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  editorGroupIdsOf,
  groupActiveTabIdOf,
  groupTabsOf,
  liveEditorViewOf,
  onEditorPathChange,
  useEditorStore,
  usesMilkdownEngine,
} from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { isSameOrInsidePath } from '@/lib/path-cross';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { activateDockPanel } from '@/shell/dock/wrap-panel-close';
import { notifyFailure } from '@/notifications/notify-thrown-error';
import { commandEditorGroupId } from './editor-groups-actions';
import { requestEditorFocus } from './editor-focus-registry';
import { openFileByPath } from './editor-file-actions';
import { editorFileDeps } from './editor-file-deps';
import { findEditorFileTabByPath } from './editor-tab-lookup';
import { isImagePreviewPath } from './editor-image';
import { EditorNavigationStack, type NavigationLocation, type NavigationSelection } from './navigation-stack';

/** 命令 id(VSCode 同)。默认键按平台见 navigationCommandHotkeys。 */
export const NAVIGATE_BACK_COMMAND_ID = 'workbench.action.navigateBack';
export const NAVIGATE_FORWARD_COMMAND_ID = 'workbench.action.navigateForward';

/**
 * 默认键(VSCode):mac ⌃- / ⌃⇧-;Windows Alt+← / Alt+→(Linux 在 VSCode 是 Ctrl+Alt+- / Ctrl+Shift+-,
 * Continuo 的平台模型不区分 Windows 与 Linux,按 Windows 取)。
 */
export function navigationCommandHotkeys(isMac: boolean): { readonly back: string; readonly forward: string } {
  return isMac ? { back: 'ctrl+-', forward: 'ctrl+shift+-' } : { back: 'alt+left', forward: 'alt+right' };
}

/** 等待目标编辑器视图挂载的上限(超时只激活不定位光标)。 */
const VIEW_WAIT_MS = 2000;

let stack = new EditorNavigationStack();
/** 正在执行后退 / 前进(可重叠:连按时前一次的读盘还没完成)。 */
let navigating = 0;
/** withoutNavigationRecording 嵌套计数。 */
let suppressed = 0;
/** replacingNavigationEntry 嵌套计数。 */
let replacing = 0;

/** 导航栈(只读;规范与调试用)。 */
export function navigationStack(): EditorNavigationStack {
  return stack;
}

/** 清空(规范用)。 */
export function resetNavigationHistory(): void {
  stack = new EditorNavigationStack();
  navigating = 0;
  suppressed = 0;
  replacing = 0;
}

/** CodeMirror 选区 → 导航光标(head 的行列;比较用选区起止中较小的行)。位置越界(文档已变短)收进范围。 */
export function navigationSelectionOf(doc: Text, selection: EditorSelection): NavigationSelection {
  const { anchor, head } = selection.main;
  const h = doc.lineAt(Math.min(head, doc.length));
  const a = doc.lineAt(Math.min(anchor, doc.length));
  return { line: h.number, column: Math.min(head, doc.length) - h.from + 1, startLine: Math.min(a.number, h.number) };
}

/** fn 期间的选区变化不记录(转到行的实时预览 / 取消恢复)。 */
export function withoutNavigationRecording<T>(fn: () => T): T {
  suppressed++;
  try {
    return fn();
  } finally {
    suppressed--;
  }
}

/**
 * fn 期间换到的编辑器不新记,而是替换当前这条(⌃Tab 按住修饰键连按:途经的编辑器不留记录,VSCode 在选择器里浏览不打开编辑器)。
 */
export function replacingNavigationEntry<T>(fn: () => T): T {
  replacing++;
  try {
    return fn();
  } finally {
    replacing--;
  }
}

function isActiveEditor(groupId: string, tabId: string): boolean {
  const s = useEditorStore.getState();
  return s.activeGroupId === groupId && groupActiveTabIdOf(s, groupId) === tabId;
}

/**
 * 编辑器组 groupId 里 tab 的光标变成 selection(before = 变化前的光标,当前这条还没有光标时据此补上)。
 * programmatic = 不是用户动作引起的选区变化(CodeMirror 事务无 userEvent,如 scrollToLine):不补 before(它只是视图刚挂载
 * 时的初始光标,用户没有停留过),目标直接替换只记文件的当前这条。
 * 不是活动编辑器 / 正在被 withoutNavigationRecording 抑制 → 忽略。
 */
export function notifyEditorSelection(
  groupId: string,
  tabId: string,
  selection: NavigationSelection,
  before?: NavigationSelection,
  programmatic = false,
): void {
  if (suppressed > 0 || !isActiveEditor(groupId, tabId)) return;
  const cur = stack.currentLocation;
  if (before && !programmatic && (!cur || cur.groupId !== groupId || cur.path !== tabId || !cur.selection)) {
    stack.notify({ groupId, path: tabId, selection: before }, navigating > 0);
  }
  stack.notify({ groupId, path: tabId, selection }, navigating > 0);
}

type StoreState = ReturnType<typeof useEditorStore.getState>;

/** 活动编辑器变了且是用户动作(见文件头)→ 记一条(带该视图当前光标,未挂载 → 只记文件)。 */
function onEditorStoreChange(s: StoreState, prev: StoreState): void {
  if (s.activeGroupId === prev.activeGroupId && s.activeTabId === prev.activeTabId) return;
  const tabId = s.activeTabId;
  if (tabId === null) return;
  const prevGone =
    prev.activeTabId !== null && !groupTabsOf(s, s.activeGroupId).some((t) => t.id === prev.activeTabId);
  if (s.editorFocusPulse === prev.editorFocusPulse && s.activeGroupId === prev.activeGroupId && !prevGone) return;
  const view = liveEditorViewOf(tabId, s.activeGroupId);
  const loc: NavigationLocation = {
    groupId: s.activeGroupId,
    path: tabId,
    selection: view ? navigationSelectionOf(view.state.doc, view.state.selection) : undefined,
  };
  if (replacing > 0 && navigating === 0) stack.replaceCurrent(loc);
  else stack.notify(loc, navigating > 0);
}

/** 订阅活动编辑器、路径变更与工作区根;返回取消订阅(EditorPlugin 卸载时)。 */
export function installNavigationHistory(): () => void {
  const offStore = useEditorStore.subscribe(onEditorStoreChange);
  const offPath = onEditorPathChange((change) => {
    if (change.kind === 'moved') stack.move(change.oldPath, change.newPath);
    else stack.remove((p) => change.paths.some((removed) => isSameOrInsidePath(removed, p)));
  });
  const offRoot = useWorkspaceStore.subscribe((s, prev) => {
    if (s.root === prev.root) return;
    const root = s.root;
    stack.remove((p) => root === null || !isSameOrInsidePath(root, p));
  });
  return () => {
    offStore();
    offPath();
    offRoot();
  };
}

/**
 * 另存为把 tab 从 oldPath 换到 newPath(BDD: src/__tests__/editor-save-as/):历史里指向原 tab 的条目改指新路径(原文件仍在,
 * 但这些位置是在这个编辑器里停留过的)。在 store 换 id 之前调用,随后的活动编辑器变化与当前这条合并。
 */
export function retargetNavigationHistory(oldPath: string, newPath: string): void {
  stack.move(oldPath, newPath);
}

/** tab 在组 groupId 里的 CodeMirror 视图挂载(或超时 → undefined)。 */
function waitForGroupView(tabId: string, groupId: string): Promise<EditorView | undefined> {
  const now = liveEditorViewOf(tabId, groupId);
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const finish = (view: EditorView | undefined): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(view);
    };
    const unsubscribe = useEditorStore.subscribe(() => {
      const view = liveEditorViewOf(tabId, groupId);
      if (view) finish(view);
    });
    const timer = setTimeout(() => finish(undefined), VIEW_WAIT_MS);
  });
}

/** 打开 / 激活该条的文件并恢复光标。fallbackGroup = 原组已不在时用的组(触发窗口的编辑器组)。 */
async function openLocation(loc: NavigationLocation, fallbackGroup: string | undefined): Promise<void> {
  const s = useEditorStore.getState();
  const groupId = editorGroupIdsOf(s).includes(loc.groupId) ? loc.groupId : (fallbackGroup ?? s.activeGroupId);
  // 编辑器组面板不是所在窗口 dock 的活动面板(同组里终端在前)→ 先显示它
  const panel = getDockApi()?.getPanel(groupId);
  if (panel) activateDockPanel(panel);
  const existing = findEditorFileTabByPath(s.tabs, loc.path);
  if (existing) {
    s.switchTab(existing.id, { groupId });
  } else if (isUntitledPath(loc.path)) {
    return; // 已关闭的无标题文件没有可重新打开的内容(不按「路径」读盘报错)
  } else {
    s.setActiveGroup(groupId);
    const r = await openFileByPath(loc.path, editorFileDeps);
    if (!r.ok) {
      notifyFailure(r);
      return;
    }
  }
  const after = useEditorStore.getState();
  const tab = findEditorFileTabByPath(after.tabs, loc.path);
  // 读盘期间用户已切到别处(openFileByPath 只在后台加入)→ 不抢焦点 / 光标
  if (!tab || groupActiveTabIdOf(after, groupId) !== tab.id) return;
  const sel = loc.selection;
  if (sel && !isImagePreviewPath(tab.filePath) && !usesMilkdownEngine(tab.filePath, tab)) {
    const view = await waitForGroupView(tab.id, groupId);
    if (view?.dom.isConnected) {
      const { scrollToLine } = await import('./scrollToLine');
      if (view.dom.isConnected) scrollToLine(view, sel.line, sel.column, undefined, { focus: false });
    }
  }
  requestEditorFocus(tab.id, groupId);
}

async function navigate(delta: 1 | -1): Promise<void> {
  // 触发窗口在第一个 await 前读出(之后不再是热键分发的同步上下文)
  const fallbackGroup = commandEditorGroupId();
  const loc = delta < 0 ? stack.back() : stack.forward();
  if (!loc) return;
  navigating++;
  try {
    await openLocation(loc, fallbackGroup);
  } finally {
    navigating--;
  }
}

/** workbench.action.navigateBack。 */
export function navigateBack(): Promise<void> {
  return navigate(-1);
}

/** workbench.action.navigateForward。 */
export function navigateForward(): Promise<void> {
  return navigate(1);
}
