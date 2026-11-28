// 调试停下时自动定位(VSCode debugSession 收到 stopped → focusStackFrame 打开停止位置;debug.openDebug 默认
// openOnDebugBreak:因断点停下时打开调试视图)。
// - 每一停(经 stopped 事件实时到达的,subscribe 快照恢复的不算)等首帧位置到达后:在编辑器以预览方式打开该文件并把该行
//   滚到中间,**不抢焦点**(刻意差异:VSCode debug.focusEditorOnBreak 默认聚焦编辑器;这里会话多由 agent 驱动,用户可能正在
//   别处打字 —— 同 agent 建终端不抢焦点)。
// - 因断点停下(reason=breakpoint)时显示调试视图:没有 → 在侧栏新建(不换活动组),有但被同组别的 tab 盖住 → 切到它。
// - 多次快速停下只定位最新一停:旧停的栈帧到达时已不是当前停点即跳过;打开文件的先后由编辑器的用户激活代际收敛。
// BDD: src/__tests__/debug-user-controls/

import { isAbsolutePath } from '@/lib/path-cross';
import { openFileInEditor } from '@/plugins/co-app';
import { revealPanelOfTypeWithoutFocus } from '@/shell/dock/dock-panel-actions';
import { DEBUG_PANEL_TYPE } from '@/shell/dock/side-panel';
import { useDebugStore } from '@/stores/debug.store';

let unsubscribe: (() => void) | null = null;
let handledKey: string | null = null;

/** 打开停止位置;期间焦点被挪走(落到 body / 编辑器)→ 还给原来的元素。 */
async function revealStopLocation(file: string, line: number): Promise<void> {
  const doc = document;
  const before = doc.activeElement as HTMLElement | null;
  await openFileInEditor(file, { line }, { preview: true }, { clampToDocument: true, preserveFocus: true });
  const after = doc.activeElement;
  if (before === null || before === after || before === doc.body || !before.isConnected) return;
  if (after === null || after === doc.body || after.closest('.cm-editor') !== null) before.focus({ preventScroll: true });
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
  if (live.reason === 'breakpoint') revealPanelOfTypeWithoutFocus(DEBUG_PANEL_TYPE);
  if (isAbsolutePath(stopped.file)) void revealStopLocation(stopped.file, stopped.line).catch(() => undefined);
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
