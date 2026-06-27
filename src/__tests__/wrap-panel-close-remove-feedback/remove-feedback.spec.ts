// @vitest-environment jsdom
// a11y(A128):关闭 terminal panel 时 coApi.terminal.remove ok:false/reject 须 notify.error,
// 不只 console.warn(panel 已消失但 PTY/session 可能未关,用户/SR 无失败反馈)。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  remove: vi.fn(),
  notifyError: vi.fn(),
  cancelPanelSpawns: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: { terminal: { remove: h.remove } },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));
vi.mock('@/panels/Terminal/spawnLeaf', () => ({
  cancelPanelSpawns: h.cancelPanelSpawns,
}));

import {
  wrapPanelClose,
  cancelPendingPanelClose,
  consumePanelCloseSuppressed,
} from '../../shell/dock/wrap-panel-close';
import { EXIT_DURATION_MS } from '../../shell/motion/tokens';
import { useClosingStore } from '../../stores/closing.store';

function makeTermPanel(sessionId: string) {
  return {
    params: { sessionId },
    api: { id: `terminal-${sessionId}`, close: vi.fn() },
  };
}

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset());
  useClosingStore.setState({ ids: new Set() });
});

describe('a11y(A128) — 关闭终端 panel remove 失败须反馈', () => {
  it('terminal.remove {ok:false} → notify.error', async () => {
    h.remove.mockResolvedValue({ ok: false, code: 'TERMINAL_NOT_FOUND' });
    const panel = makeTermPanel('s1');
    wrapPanelClose(panel as never);
    panel.api.close();
    await vi.waitFor(() => {
      expect(h.remove).toHaveBeenCalledWith('s1');
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('terminal.remove reject → notify.error', async () => {
    h.remove.mockRejectedValue(new Error('ipc down'));
    const panel = makeTermPanel('s2');
    wrapPanelClose(panel as never);
    panel.api.close();
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('terminal.remove {ok:true} → 不报错', async () => {
    h.remove.mockResolvedValue({ ok: true });
    const panel = makeTermPanel('s3');
    wrapPanelClose(panel as never);
    panel.api.close();
    await vi.waitFor(() => {
      expect(h.remove).toHaveBeenCalledWith('s3');
    });
    expect(h.notifyError).not.toHaveBeenCalled();
  });
});

describe('race(R44) — EXIT 动画窗口内复活面板不删 PTY/session', () => {
  it('close 后 cancelPendingPanelClose → 不删 PTY、不 cancel spawn、不真 close', () => {
    vi.useFakeTimers();
    try {
      h.remove.mockResolvedValue({ ok: true });
      const panel = makeTermPanel('s4');
      const originalClose = panel.api.close; // wrap 前捕获原 close
      wrapPanelClose(panel as never);
      panel.api.close(); // 排定延迟 close(PTY 删除已移入 timer)

      cancelPendingPanelClose('terminal-s4'); // 动画窗口内复活
      vi.advanceTimersByTime(EXIT_DURATION_MS + 10);

      expect(h.remove).not.toHaveBeenCalled(); // PTY/session 保留
      expect(h.cancelPanelSpawns).not.toHaveBeenCalled(); // 不取消在途 spawn
      expect(originalClose).not.toHaveBeenCalled(); // 真 close 被取消
    } finally {
      vi.useRealTimers();
    }
  });

  // race(R80):真实 close 路径须在 original() 前 markPanelCloseSuppressed,否则 onDidRemovePanel
  // → handleTerminalPanelRemoved 再发第二次 terminal.remove(与 removeTerminalPtysForPanel 并发 →
  // NOT_FOUND 误报 + 重复 kill)。验证:真 close 落地后 terminal panel id 已被标记 suppressed。
  it('R80 真 close 落地后 terminal panel 被标记 suppressed(handleTerminalPanelRemoved 会早退)', () => {
    vi.useFakeTimers();
    try {
      h.remove.mockResolvedValue({ ok: true });
      const panel = makeTermPanel('s6');
      wrapPanelClose(panel as never);
      panel.api.close();
      vi.advanceTimersByTime(EXIT_DURATION_MS + 10); // timer 到点:删 PTY + 标记 suppressed + 真 close

      // consume 返回 true → 说明真 close 路径已标记 → handleTerminalPanelRemoved 会早退不重复删除。
      expect(consumePanelCloseSuppressed('terminal-s6')).toBe(true);
      // 取走后再 consume 为 false(已被消费)。
      expect(consumePanelCloseSuppressed('terminal-s6')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('R80 取消的 close 不标记 suppressed(无泄漏)', () => {
    vi.useFakeTimers();
    try {
      h.remove.mockResolvedValue({ ok: true });
      const panel = makeTermPanel('s7');
      wrapPanelClose(panel as never);
      panel.api.close();
      cancelPendingPanelClose('terminal-s7'); // 复活,timer 不跑
      vi.advanceTimersByTime(EXIT_DURATION_MS + 10);

      // 真 close 未执行 → 未标记。
      expect(consumePanelCloseSuppressed('terminal-s7')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close 后不取消 → timer 到点才删 PTY + 真 close(对照)', () => {
    vi.useFakeTimers();
    try {
      h.remove.mockResolvedValue({ ok: true });
      const panel = makeTermPanel('s5');
      const originalClose = panel.api.close;
      wrapPanelClose(panel as never);
      panel.api.close();

      // 排定时尚未删 PTY(已移入 timer)。
      expect(h.remove).not.toHaveBeenCalled();
      vi.advanceTimersByTime(EXIT_DURATION_MS + 10);

      expect(h.remove).toHaveBeenCalledWith('s5');
      expect(h.cancelPanelSpawns).toHaveBeenCalledWith('terminal-s5');
      expect(originalClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
