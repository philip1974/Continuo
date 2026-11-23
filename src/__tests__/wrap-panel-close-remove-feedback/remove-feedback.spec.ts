// @vitest-environment jsdom
// 关闭终端面板 → 删会话只有一个入口:真 close 触发 dockview 的 onDidRemovePanel → handleTerminalPanelRemoved
// → removeTerminalSessionWithFeedback。wrapPanelClose 自己不发 terminal.remove(此前两条路径各发一次,
// 靠 suppressed 标记互相去重,R80)。
// a11y(A128):coApi.terminal.remove ok:false/reject 须 notify.error,不只 console.warn
//(panel 已消失但 PTY/session 可能未关,用户/SR 无失败反馈)。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  remove: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: { terminal: { remove: h.remove } },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));

import {
  wrapPanelClose,
  cancelPendingPanelClose,
  consumePanelCloseSuppressed,
  markPanelCloseSuppressed,
} from '../../shell/dock/wrap-panel-close';
import {
  handleTerminalPanelRemoved,
  removeTerminalSessionWithFeedback,
} from '../../shell/dock/DockReconciler';
import { EXIT_DURATION_MS } from '../../shell/motion/tokens';
import { useClosingStore } from '../../stores/closing.store';

/** 模拟 dockview:真 close 同步触发 onDidRemovePanel(DockShell 在其中调 handleTerminalPanelRemoved)。 */
function makeTermPanel(sessionId: string) {
  const panel = {
    params: { sessionId },
    api: { id: `terminal-${sessionId}`, close: vi.fn() },
  };
  const original = panel.api.close;
  original.mockImplementation(() => {
    void handleTerminalPanelRemoved({
      panel: panel as never,
      api: { getPanel: () => undefined } as never,
      removeSession: removeTerminalSessionWithFeedback,
    });
  });
  wrapPanelClose(panel as never);
  return { panel, original };
}

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset());
  useClosingStore.setState({ ids: new Set() });
});

describe('a11y(A128) — 关闭终端 panel remove 失败须反馈', () => {
  it('terminal.remove {ok:false} → notify.error', async () => {
    h.remove.mockResolvedValue({ ok: false, code: 'TERMINAL_NOT_FOUND' });
    await removeTerminalSessionWithFeedback('s1');
    expect(h.remove).toHaveBeenCalledWith('s1');
    expect(h.notifyError).toHaveBeenCalledTimes(1);
  });

  it('terminal.remove reject → notify.error(不再向外抛)', async () => {
    h.remove.mockRejectedValue(new Error('ipc down'));
    await expect(removeTerminalSessionWithFeedback('s2')).resolves.toBeUndefined();
    expect(h.notifyError).toHaveBeenCalledTimes(1);
  });

  it('terminal.remove {ok:true} → 不报错', async () => {
    h.remove.mockResolvedValue({ ok: true });
    await removeTerminalSessionWithFeedback('s3');
    expect(h.remove).toHaveBeenCalledWith('s3');
    expect(h.notifyError).not.toHaveBeenCalled();
  });
});

describe('关闭终端面板 → 会话只删一次,且只在真 close 之后', () => {
  it('race(R44) close 后 cancelPendingPanelClose(动画窗口内复活)→ 不删会话、不真 close', async () => {
    vi.useFakeTimers();
    try {
      h.remove.mockResolvedValue({ ok: true });
      const { panel, original } = makeTermPanel('s4');
      panel.api.close(); // 排定延迟 close

      cancelPendingPanelClose('terminal-s4'); // 动画窗口内复活
      await vi.advanceTimersByTimeAsync(EXIT_DURATION_MS + 10);

      expect(h.remove).not.toHaveBeenCalled(); // PTY/session 保留
      expect(original).not.toHaveBeenCalled(); // 真 close 被取消
    } finally {
      vi.useRealTimers();
    }
  });

  it('close 后不取消 → timer 到点才真 close,随后 terminal.remove 恰好一次(R80:不再有第二条删除路径)', async () => {
    vi.useFakeTimers();
    try {
      h.remove.mockResolvedValue({ ok: true });
      const { panel, original } = makeTermPanel('s5');
      panel.api.close();

      // 排定时尚未删会话。
      expect(h.remove).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(EXIT_DURATION_MS + 10);

      expect(original).toHaveBeenCalledTimes(1);
      expect(h.remove).toHaveBeenCalledTimes(1);
      expect(h.remove).toHaveBeenCalledWith('s5');
    } finally {
      vi.useRealTimers();
    }
  });

  it('用户关闭不留下 suppressed 标记(无泄漏)', async () => {
    vi.useFakeTimers();
    try {
      h.remove.mockResolvedValue({ ok: true });
      const { panel } = makeTermPanel('s6');
      panel.api.close();
      await vi.advanceTimersByTimeAsync(EXIT_DURATION_MS + 10);
      expect(consumePanelCloseSuppressed('terminal-s6')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('用户关闭的动画期间 reconciler 补标 → 真 close 前清掉,会话照删,标记不残留', async () => {
    vi.useFakeTimers();
    try {
      h.remove.mockResolvedValue({ ok: true });
      const { panel } = makeTermPanel('s7');
      panel.api.close();
      markPanelCloseSuppressed('terminal-s7');
      await vi.advanceTimersByTimeAsync(EXIT_DURATION_MS + 10);
      expect(h.remove).toHaveBeenCalledWith('s7');
      expect(consumePanelCloseSuppressed('terminal-s7')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('original close 抛错(面板已被别的路径移除)→ 静默,不删会话(那条路径的 onDidRemovePanel 已处理)', async () => {
    vi.useFakeTimers();
    try {
      h.remove.mockResolvedValue({ ok: true });
      const { panel, original } = makeTermPanel('s8');
      original.mockImplementation(() => {
        throw new Error('panel already detached');
      });
      panel.api.close();
      await vi.advanceTimersByTimeAsync(EXIT_DURATION_MS + 10);

      expect(h.remove).not.toHaveBeenCalled();
      expect(consumePanelCloseSuppressed('terminal-s8')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
