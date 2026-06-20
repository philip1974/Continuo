import type { IDockviewPanel } from 'dockview-react';
import { useClosingStore } from '@/stores/closing.store';
import { EXIT_DURATION_MS } from '@/shell/motion/tokens';
import { coApi } from '@/lib/co-api';
import { cancelPanelSpawns } from '@/panels/Terminal/spawnLeaf';
import { isTerminalPanelId, sessionIdFromPanel } from './terminal-panel-id';

const patched = new WeakSet<IDockviewPanel>();
const suppressedPanelCloses = new Set<string>();
// 每个 panel id 排定中的「真 close」timer。供 cancelPendingPanelClose 在面板于
// EXIT 动画窗口(EXIT_DURATION_MS)内被重新激活时撤销,防止刚复活的面板又被关。
const pendingCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 撤销某 panel 排定中的延迟 close 并清掉它的 closing 标记。用于「关了又马上点开」
 * 的复活路径:wrapPanelClose 把真 close 延后 EXIT_DURATION_MS,这段时间里 panel
 * 仍存在;若此时 DockShell editor 激活 effect 命中它并 setActive,必须取消那个已
 * 排定的真 close,否则面板(及刚打开的文件)会在动画结束时凭空消失。
 * 非 pending 时调用是无害 no-op(幂等)。
 */
export function cancelPendingPanelClose(panelId: string): void {
  const timer = pendingCloseTimers.get(panelId);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingCloseTimers.delete(panelId);
  }
  useClosingStore.getState().unmark(panelId);
}

export function markPanelCloseSuppressed(panelId: string): void {
  suppressedPanelCloses.add(panelId);
}

export function consumePanelCloseSuppressed(panelId: string): boolean {
  const suppressed = suppressedPanelCloses.has(panelId);
  suppressedPanelCloses.delete(panelId);
  return suppressed;
}

// 给每个 panel 的 api.close 包一层:先把 id 放进 closing-store(让 PanelMount
// 走 EXIT 动画),EXIT_DURATION_MS 后再真正调 close。统一拦在 api 层而不是
// SharedTab,这样所有 close 路径(× 按钮 / 中键 / 群组级关闭 / 第三方调用)
// 都自动走动画。
//
// 幂等:同一 panel 多次 patch 只生效第一次(WeakSet 守);同一 panel 多次 close
// 调用,只有第一次进入 store + 设 timeout(closing-store.mark 自身去重)。
export function wrapPanelClose(panel: IDockviewPanel): void {
  if (patched.has(panel)) return;
  patched.add(panel);

  const original = panel.api.close.bind(panel.api);
  Object.defineProperty(panel.api, 'close', {
    value: () => {
      const id = panel.api.id;
      const store = useClosingStore.getState();
      if (store.ids.has(id)) return;
      store.mark(id);
      removeTerminalPtysForPanel(panel);
      const timer = setTimeout(() => {
        pendingCloseTimers.delete(id);
        try {
          original();
        } catch {
          // panel 已被其他路径(group teardown 等)移除,忽略。
        }
      }, EXIT_DURATION_MS);
      pendingCloseTimers.set(id, timer);
    },
    writable: true,
    configurable: true,
  });
}

function removeTerminalPtysForPanel(panel: IDockviewPanel): void {
  if (!isTerminalPanelId(panel.api.id)) return;
  // 真 close:取消该 panel 还在 in-flight 的 spawn,防 PTY 孤儿
  cancelPanelSpawns(panel.api.id);
  const sessionId = sessionIdFromPanel(panel);
  if (!sessionId) return;
  void coApi.terminal.remove(sessionId).then((r) => {
    if (!r.ok) {
      console.warn('[terminal-panel] remove ok=false', sessionId, r);
    }
  }, (err) => {
    console.warn('[terminal-panel] remove rejected', sessionId, err);
  });
}
