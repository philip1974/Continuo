// 调试停下时自动定位(VSCode debugSession 收到 stopped → focusStackFrame → StackFrame.openInEditor:在活动编辑器组打开
// 停止位置,revealIfOpened;preserveFocus = !debug.focusEditorOnBreak(默认 true → 聚焦编辑器)。debug.openDebug 默认
// openOnDebugBreak:因断点停下时打开调试视图)。每一停(经 stopped 事件实时到达的,subscribe 快照恢复的不算)等首帧位置到达后:
// - **用户自己的调试操作**引起的停下(本窗口调试工具栏 / F5 F6 F10 F11 ⇧F11,见 lastLiveStop.byUser):照 VSCode,以预览方式
//   在活动编辑器组打开该文件并把焦点交给编辑器。
// - **其它**(agent 经 MCP 驱动 / 程序自己撞上断点):会话多由 agent 驱动、用户可能正在别处打字 —— 不抢焦点,且不得换下 / 盖住
//   焦点所在的面板或编辑器(刻意差异:VSCode 的终端在独立面板区,打开停止位置盖不住它;这里终端与编辑器可在同一 dock 组):
//   - 在活动编辑器组打开不会盖住焦点所在面板 → 照旧打开(不抢焦点);
//   - 会盖住(焦点就在活动编辑器组里,或焦点所在面板与它同在一个 dock 组)→ 改投另一个正在显示、且不与焦点面板同组的编辑器组,
//     后台打开(不换活动编辑器组、不激活 dock 面板);没有这样的组 → 不打开(执行行装饰与调试视图照常更新)。
//   - 焦点仍丢到了 body(原元素被卸载)→ 交给停止位置的编辑器,不让按键落空。
// - 因断点停下(reason=breakpoint)时显示调试视图:没有 → 在侧栏新建(不换活动组),有但被同组别的 tab 盖住 → 切到它;
//   非用户引起的停下同样不盖住焦点所在面板。
// - 多次快速停下只定位最新一停:旧停的栈帧到达时已不是当前停点即跳过;打开文件的先后由编辑器的用户激活代际收敛。
// BDD: src/__tests__/debug-user-controls/

import { isAbsolutePath } from '@/lib/path-cross';
import { openFileInEditor } from '@/plugins/co-app';
import { dockPanelContaining, revealPanelOfTypeWithoutFocus } from '@/shell/dock/dock-panel-actions';
import { getDockApi } from '@/shell/dock/dock-api-ref';
import { DEBUG_PANEL_TYPE } from '@/shell/dock/side-panel';
import { useDebugStore } from '@/stores/debug.store';
import { editorGroupIdsOf, liveEditorViewOf, useEditorStore } from '@/stores/editor.store';
import { openFileByPath } from '@/panels/Editor/editor-file-actions';
import { editorFileDeps } from '@/panels/Editor/editor-file-deps';
import { findEditorFileTabByPath } from '@/panels/Editor/editor-tab-lookup';

let unsubscribe: (() => void) | null = null;
let handledKey: string | null = null;

/** 非用户引起的停下打开到哪:活动编辑器组(照旧)、另一个编辑器组(后台)、不打开。 */
export type AgentStopTarget = { readonly kind: 'active' } | { readonly kind: 'group'; readonly groupId: string } | { readonly kind: 'none' };

/**
 * 非用户引起的停下,停止位置该打开在哪(不盖住 focused 所在的面板 / 编辑器)。dock 未就绪 / 焦点不在任何 dock 面板里 → 活动组。
 */
export function agentStopTarget(focused: Element | null): AgentStopTarget {
  const api = getDockApi();
  if (!api) return { kind: 'active' };
  const focusedPanel = dockPanelContaining(api, focused);
  if (focusedPanel === undefined) return { kind: 'active' };
  const editor = useEditorStore.getState();
  const activePanel = api.getPanel(editor.activeGroupId);
  // 活动组面板不在 dock 里(用户关掉了编辑器)→ 打开时会补建,落点不可控,按会盖住处理。
  const covers =
    activePanel === undefined ||
    activePanel === focusedPanel ||
    (activePanel.group === focusedPanel.group && activePanel.group.activePanel !== activePanel);
  if (!covers) return { kind: 'active' };
  for (const groupId of editorGroupIdsOf(editor)) {
    if (groupId === editor.activeGroupId) continue;
    const panel = api.getPanel(groupId);
    if (panel === undefined || panel === focusedPanel || panel.group === focusedPanel.group) continue;
    if (panel.group.activePanel !== panel) continue; // 被同组别的 tab 盖着:打开了也看不到
    return { kind: 'group', groupId };
  }
  return { kind: 'none' };
}

const VIEW_WAIT_MS = 1000;
const VIEW_POLL_MS = 25;

/** 在 groupId 组里后台打开 file 并把 line 滚到中间(光标移到该行;不聚焦)。 */
async function revealInBackgroundGroup(file: string, line: number, groupId: string): Promise<void> {
  const opened = await openFileByPath(file, editorFileDeps, { preview: true, groupId, requestFocus: false });
  if (!opened.ok) return;
  const tab = findEditorFileTabByPath(useEditorStore.getState().tabs, file);
  if (!tab) return;
  const deadline = Date.now() + VIEW_WAIT_MS;
  let view = liveEditorViewOf(tab.id, groupId);
  while (view === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, VIEW_POLL_MS));
    view = liveEditorViewOf(tab.id, groupId);
  }
  if (view === undefined) return;
  const { scrollToLine } = await import('@/panels/Editor/scrollToLine');
  scrollToLine(view, Math.min(Math.max(line, 1), view.state.doc.lines), undefined, undefined, { focus: false });
}

/** 焦点丢到 body(原元素被卸载)→ 交给活动编辑器(停止位置),不让按键落空。 */
function focusActiveEditorIfLost(): void {
  const doc = document;
  if (doc.activeElement !== null && doc.activeElement !== doc.body) return;
  const editor = useEditorStore.getState();
  const id = editor.activeTabId;
  const view = id === null ? undefined : (liveEditorViewOf(id, editor.activeGroupId) ?? editor.viewRefs.get(id));
  view?.focus();
}

/** 打开停止位置。byUser:VSCode focusEditorOnBreak —— 焦点进编辑器;否则见文件头。 */
async function revealStopLocation(file: string, line: number, byUser: boolean): Promise<void> {
  if (byUser) {
    await openFileInEditor(file, { line }, { preview: true }, { clampToDocument: true });
    return;
  }
  const doc = document;
  const before = doc.activeElement as HTMLElement | null;
  const target = agentStopTarget(before);
  if (target.kind === 'none') return;
  if (target.kind === 'group') {
    await revealInBackgroundGroup(file, line, target.groupId);
  } else {
    await openFileInEditor(file, { line }, { preview: true }, { clampToDocument: true, preserveFocus: true });
  }
  const after = doc.activeElement;
  if (before !== null && before !== after && before !== doc.body && before.isConnected) {
    // 期间焦点被挪走(落到 body / 编辑器)→ 还给原来的元素。
    if (after === null || after === doc.body || after.closest('.cm-editor') !== null) before.focus({ preventScroll: true });
    return;
  }
  focusActiveEditorIfLost();
}

function onDebugStateChange(): void {
  const state = useDebugStore.getState();
  const live = state.lastLiveStop;
  if (live === null) return;
  const key = `${live.sessionId}\u0000${live.stopSeq}`;
  if (handledKey === key) return;
  const stopped = state.sessions.get(live.sessionId)?.stopped;
  // 已继续运行 / 已有更新的一停 / 已不是显示的会话:这一停不再定位。
  if (stopped?.stopSeq !== live.stopSeq || state.activeSessionId !== live.sessionId) {
    handledKey = key;
    return;
  }
  if (stopped.file === undefined || stopped.line === undefined) return; // 等栈帧
  handledKey = key;
  if (live.reason === 'breakpoint') {
    revealPanelOfTypeWithoutFocus(DEBUG_PANEL_TYPE, live.byUser ? undefined : { keepFocusedVisible: true });
  }
  if (isAbsolutePath(stopped.file)) void revealStopLocation(stopped.file, stopped.line, live.byUser).catch(() => undefined);
}

/** renderer 启动时调用一次(幂等)。 */
export function startDebugAutoReveal(): () => void {
  if (unsubscribe === null) {
    unsubscribe = useDebugStore.subscribe((next, prev) => {
      if (next.lastLiveStop !== prev.lastLiveStop || next.sessions !== prev.sessions) onDebugStateChange();
    });
  }
  return () => {
    unsubscribe?.();
    unsubscribe = null;
    handledKey = null;
  };
}
