// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { TerminalSessionsSync } from '../../shell/dock/TerminalSessionsSync';
import {
  useTerminalStore,
  type TerminalSession,
} from '../../stores/terminal.store';

const mocks = vi.hoisted(() => {
  let onChanged: ((sessions: TerminalSession[]) => void) | null = null;
  return {
    listSessions: vi.fn(),
    unsubscribe: vi.fn(),
    onSessionsChanged: vi.fn((cb: (sessions: TerminalSession[]) => void) => {
      onChanged = cb;
      return mocks.unsubscribe;
    }),
    emitSessionsChanged: (sessions: TerminalSession[]) => onChanged?.(sessions),
    notifyError: vi.fn(),
  };
});

vi.mock('@/lib/co-api', () => ({
  coApi: {
    system: { windowId: 1 },
    terminal: {
      listSessions: mocks.listSessions,
      onSessionsChanged: mocks.onSessionsChanged,
    },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: mocks.notifyError } }));

function session(id: string, over: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id,
    title: id,
    cwd: '/repo',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ...over,
    ownerWindowId: 1,
  };
}

beforeEach(() => {
  mocks.listSessions.mockReset();
  mocks.listSessions.mockResolvedValue({ ok: true, data: { sessions: [] } });
  mocks.unsubscribe.mockReset();
  mocks.onSessionsChanged.mockClear();
  mocks.notifyError.mockReset();
  useTerminalStore.setState({
    sessions: [],
    activeId: null,
    customTitles: new Map(),
  });
});

afterEach(() => {
  cleanup();
});

describe('TerminalSessionsSync', () => {
  it('mount 后 listSessions 被调用一次', async () => {
    render(React.createElement(TerminalSessionsSync));

    await waitFor(() => {
      expect(mocks.listSessions).toHaveBeenCalledTimes(1);
    });
    expect(mocks.listSessions).toHaveBeenCalledWith();
  });

  // a11y(A130,A129 同族):初始会话恢复失败须 notify.error,不静默(reject / !ok)。
  it('listSessions reject → notify.error', async () => {
    mocks.listSessions.mockRejectedValue(new Error('ipc down'));
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(mocks.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('listSessions {ok:false} → notify.error', async () => {
    mocks.listSessions.mockResolvedValue({ ok: false, code: 'EIO' });
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(mocks.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('listSessions ok → replaceSnapshot 同步初始 sessions,保留 originHint', async () => {
    mocks.listSessions.mockResolvedValue({
      ok: true,
      data: { sessions: [session('agent-1', { originHint: 'agent' })] },
    });

    render(React.createElement(TerminalSessionsSync));

    await waitFor(() => {
      expect(useTerminalStore.getState().sessions.map((s) => s.id)).toEqual([
        'agent-1',
      ]);
    });
    expect(useTerminalStore.getState().sessions[0]?.originHint).toBe('agent');
  });

  it('onSessionsChanged 推送 → useTerminalStore.sessions 同步更新', async () => {
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(mocks.onSessionsChanged).toHaveBeenCalledTimes(1);
    });

    act(() => {
      mocks.emitSessionsChanged([session('s1'), session('s2')]);
    });

    expect(useTerminalStore.getState().sessions.map((s) => s.id)).toEqual([
      's1',
      's2',
    ]);
  });

  // 边界(E174,E168-E173 同族 IPC ingress 纵深防御):实时 sessions_changed 广播须先 Array.isArray —
  // 初始 listSessions 路径已有该守卫,广播路径此前缺,畸形 payload 在 filterByOwnerWindow 的 for...of
  // 抛 → 中断同步、列表停旧态。非法 → notify + drop,不抛、不污染 store。
  it('E174 畸形广播(null/对象/字符串)→ notify + drop,store 不变、不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.listSessions.mockResolvedValue({
      ok: true,
      data: { sessions: [session('keep')] },
    });
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(mocks.onSessionsChanged).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(useTerminalStore.getState().sessions.map((s) => s.id)).toEqual([
        'keep',
      ]);
    });
    mocks.notifyError.mockReset();

    const emitBad = mocks.emitSessionsChanged as unknown as (p: unknown) => void;
    act(() => {
      expect(() => {
        emitBad(null);
        emitBad('a string');
        emitBad({ not: 'an array' });
        emitBad(42);
      }).not.toThrow();
    });

    // store 保持初始 hydration(未被畸形广播污染),notify 被调用
    expect(useTerminalStore.getState().sessions.map((s) => s.id)).toEqual([
      'keep',
    ]);
    expect(mocks.notifyError).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('E174 畸形广播后合规广播仍正常更新(回归)', async () => {
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(mocks.onSessionsChanged).toHaveBeenCalledTimes(1);
    });
    const emitAny = mocks.emitSessionsChanged as unknown as (p: unknown) => void;
    act(() => {
      emitAny(null); // 畸形,丢弃
      mocks.emitSessionsChanged([session('s9')]); // 合规
    });
    expect(useTerminalStore.getState().sessions.map((s) => s.id)).toEqual(['s9']);
  });

  it('unmount → 调 onSessionsChanged 返回的 unsubscribe', async () => {
    const { unmount } = render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(mocks.onSessionsChanged).toHaveBeenCalledTimes(1);
    });

    unmount();

    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
