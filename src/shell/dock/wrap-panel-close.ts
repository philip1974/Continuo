import type { IDockviewPanel } from 'dockview-react';
import { useClosingStore } from '@/stores/closing.store';
import { EXIT_DURATION_MS } from '@/shell/motion/tokens';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { t as translate } from '@/i18n';
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
      const timer = setTimeout(() => {
        pendingCloseTimers.delete(id);
        // race(R44):terminal PTY/session 删除 + cancel spawn 移到延迟 timer 内、紧挨 original()
        // 前执行。此前在排定 close 时立即执行,早于这段可取消的真 close;用户在 EXIT 动画窗口内复活
        // 面板(cancelPendingPanelClose 清 timer)时,close 被取消但 PTY/session 已删 → 留下 session
        // 缺失的死面板。移入 timer:取消路径清掉 timer 即不会执行 terminal 删除,面板与会话都保留。
        removeTerminalPtysForPanel(panel);
        // race(R80):按 src/shell/dock/README.md 约定,真实 close 路径必须在 original() 之前
        // markPanelCloseSuppressed(id)。否则 original() 触发 dockview onDidRemovePanel →
        // handleTerminalPanelRemoved 时 consumePanelCloseSuppressed 返回 false → 经 move-vs-close
        // 兜底(panel 已删)再发**第二次** terminal.remove。两 remove IPC 并发:若第二个先删
        // metadata,第一个(removeTerminalPtysForPanel 内)收 NOT_FOUND → 误报「关闭失败」,且重复
        // kill 同一 PTY session。标记后 onDidRemovePanel 只负责 move-vs-close 兜底,不反向重复删除。
        // 仅 terminal panel 需要(consume 端只对 terminal panel 接线);非 terminal id 不标记,
        // 以免泄漏进 suppressedPanelCloses 集(无人 consume)。
        if (isTerminalPanelId(id)) markPanelCloseSuppressed(id);
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
  // a11y(A128):关闭终端 panel 时 remove 失败此前只 console.warn → panel 已消失但 PTY/session
  // 可能未关,用户/SR 无失败反馈。ok:false 与 reject 都补 notify.error(保留 console.warn 作日志)。
  void coApi.terminal.remove(sessionId).then((r) => {
    if (!r.ok) {
      console.warn('[terminal-panel] remove ok=false', sessionId, r);
      notify.error(
        translate('errors.terminal.remove_failed', { code: r.code ?? '?' }),
        { code: r.code },
      );
    }
  }, (err) => {
    console.warn('[terminal-panel] remove rejected', sessionId, err);
    const code = (err as { code?: string })?.code ?? 'EXCEPTION';
    notify.error(translate('errors.terminal.remove_failed', { code }), { code });
  });
}
