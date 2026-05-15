import type { IDockviewPanel } from 'dockview-react';
import { useClosingStore } from '@/stores/closing.store';
import { EXIT_DURATION_MS } from '@/shell/motion/tokens';
import { coApi } from '@/lib/co-api';
import { cancelPanelSpawns } from '@/panels/Terminal/spawnLeaf';
import { isTerminalPanelId, sessionIdFromPanel } from './terminal-panel-id';

const patched = new WeakSet<IDockviewPanel>();
const suppressedPanelCloses = new Set<string>();

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
      setTimeout(() => {
        try {
          original();
        } catch {
          // panel 已被其他路径(group teardown 等)移除,忽略。
        }
      }, EXIT_DURATION_MS);
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
