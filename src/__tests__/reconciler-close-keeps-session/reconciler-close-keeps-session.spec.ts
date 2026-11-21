// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ remove: vi.fn() }));

vi.mock('@/lib/co-api', () => ({ coApi: { terminal: { remove: h.remove } } }));
vi.mock('@/notifications/notify', () => ({ notify: { error: vi.fn() } }));

import type { DockviewApi } from 'dockview-react';
import { reconcileTerminalPanels, handleTerminalPanelRemoved } from '../../shell/dock/DockReconciler';
import {
  wrapPanelClose,
  markPanelCloseSuppressed,
  consumePanelCloseSuppressed,
} from '../../shell/dock/wrap-panel-close';
import { EXIT_DURATION_MS } from '../../shell/motion/tokens';
import { useClosingStore } from '../../stores/closing.store';

function makeTermPanel(sessionId: string) {
  const original = vi.fn();
  const panel = { params: { sessionId }, api: { id: `terminal-${sessionId}`, close: original } };
  wrapPanelClose(panel as never);
  return { panel, original };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.remove.mockReset().mockResolvedValue({ ok: true });
  useClosingStore.setState({ ids: new Set() });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reconciler 关闭终端面板不删除会话', () => {
  it('reconciler 关闭(先标记 suppressed)→ 只关面板,不 remove', () => {
    const { panel, original } = makeTermPanel('a');
    markPanelCloseSuppressed(panel.api.id);
    panel.api.close();
    vi.advanceTimersByTime(EXIT_DURATION_MS);
    expect(original).toHaveBeenCalledTimes(1);
    expect(h.remove).not.toHaveBeenCalled();
    consumePanelCloseSuppressed(panel.api.id);
  });

  it('用户关闭 → remove 该会话', () => {
    const { panel, original } = makeTermPanel('b');
    panel.api.close();
    vi.advanceTimersByTime(EXIT_DURATION_MS);
    expect(original).toHaveBeenCalledTimes(1);
    expect(h.remove).toHaveBeenCalledWith('b');
    consumePanelCloseSuppressed(panel.api.id);
  });

  it('用户先关、动画期间 reconciler 才标记 → 仍按用户关闭 remove', () => {
    const { panel } = makeTermPanel('c');
    panel.api.close();
    markPanelCloseSuppressed(panel.api.id);
    panel.api.close(); // reconciler 的 close:动画中,no-op
    vi.advanceTimersByTime(EXIT_DURATION_MS);
    expect(h.remove).toHaveBeenCalledWith('c');
    consumePanelCloseSuppressed(panel.api.id);
  });
});

describe('EXIT 动画期间会话重新可见 → 撤销 reconciler 关闭', () => {
  const session = {
    id: 's1', title: 'T', cwd: '/a', originHint: 'user', createdAt: 1,
    exitCode: null, ownerWindowId: 1, workspaceRoot: '/a',
  } as never;

  interface FakePanel {
    id: string;
    params: unknown;
    api: { id: string; setActive: () => void; setTitle: () => void; title: string; close: () => void };
  }

  function makeApi() {
    const panels: Record<string, FakePanel> = {};
    const api = {
      addPanel: vi.fn((o: { id: string; params: unknown }) => {
        const p: FakePanel = {
          id: o.id,
          params: o.params,
          api: { id: o.id, setActive: vi.fn(), setTitle: vi.fn(), title: 'T', close: () => {} },
        };
        p.api.close = () => {
          delete panels[o.id];
          void handleTerminalPanelRemoved({ panel: p as never, api: api as never, removeSession: h.remove });
        };
        panels[o.id] = p;
        wrapPanelClose(p as never);
        return p;
      }),
      getPanel: (id: string) => panels[id],
      get panels() {
        return Object.values(panels);
      },
    };
    return api as unknown as DockviewApi;
  }

  it('切走又在动画内切回 → 面板保留,会话不删', async () => {
    const api = makeApi();
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [session] });
    reconcileTerminalPanels(api, { previousSessions: [session], nextSessions: [] });
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [session] });
    vi.advanceTimersByTime(EXIT_DURATION_MS);
    await Promise.resolve();
    expect(api.getPanel('terminal-s1')).toBeDefined();
    expect(h.remove).not.toHaveBeenCalled();
    expect(useClosingStore.getState().ids.has('terminal-s1')).toBe(false);
  });

  it('撤销时同步标题到会话最新状态', () => {
    const api = makeApi();
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [session] });
    reconcileTerminalPanels(api, { previousSessions: [session], nextSessions: [] });
    const renamed = { ...(session as object), title: 'vim foo.ts' } as never;
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [renamed] });
    expect(api.getPanel('terminal-s1')!.api.setTitle).toHaveBeenCalled();
  });

  it('撤销后用户再关闭该面板 → 照常 remove(不残留 suppressed 标记)', async () => {
    const api = makeApi();
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [session] });
    reconcileTerminalPanels(api, { previousSessions: [session], nextSessions: [] });
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [session] });
    vi.advanceTimersByTime(EXIT_DURATION_MS);
    api.getPanel('terminal-s1')!.api.close();
    vi.advanceTimersByTime(EXIT_DURATION_MS);
    await Promise.resolve();
    expect(h.remove).toHaveBeenCalledWith('s1');
  });
});
