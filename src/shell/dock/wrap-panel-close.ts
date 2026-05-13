import type { IDockviewPanel } from 'dockview-react';
import { useClosingStore } from '@/stores/closing.store';
import { EXIT_DURATION_MS } from '@/shell/motion/tokens';
import { coApi } from '@/lib/co-api';

const patched = new WeakSet<IDockviewPanel>();

function getScopedTerminalSessionId(panel: IDockviewPanel): string | null {
  if (!panel.api.id.startsWith('terminal-')) return null;
  const params = panel.params ?? panel.api.getParameters();
  if (!params || typeof params !== 'object') return null;
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0
    ? sessionId
    : null;
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
      const scopedSessionId = getScopedTerminalSessionId(panel);
      if (scopedSessionId) {
        void coApi.terminal.remove(scopedSessionId);
      }
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
