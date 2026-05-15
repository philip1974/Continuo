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
  };
});

vi.mock('@/lib/co-api', () => ({
  coApi: {
    terminal: {
      listSessions: mocks.listSessions,
      onSessionsChanged: mocks.onSessionsChanged,
    },
  },
}));

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

  it('unmount → 调 onSessionsChanged 返回的 unsubscribe', async () => {
    const { unmount } = render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(mocks.onSessionsChanged).toHaveBeenCalledTimes(1);
    });

    unmount();

    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
