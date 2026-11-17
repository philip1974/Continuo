// @vitest-environment jsdom
// TerminalSessionsSync 置位 useTerminalStore.hydrated(Splash 就绪屏障的终端一侧):首个有效快照(含空快照)
// 应用即置位;初始拉取失败也置位(不让 Splash 白等安全上限);畸形广播不置位。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { TerminalSessionsSync } from '../../shell/dock/TerminalSessionsSync';
import { useTerminalStore, type TerminalSession } from '../../stores/terminal.store';

const mocks = vi.hoisted(() => {
  let onChanged: ((sessions: unknown) => void) | null = null;
  return {
    listSessions: vi.fn(),
    onSessionsChanged: vi.fn((cb: (sessions: unknown) => void) => {
      onChanged = cb;
      return () => {};
    }),
    emit: (sessions: unknown) => onChanged?.(sessions),
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
vi.mock('@/notifications/notify', () => ({ notify: { error: vi.fn() } }));

function session(id: string): TerminalSession {
  return {
    id,
    title: id,
    cwd: '/repo',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ownerWindowId: 1,
  };
}

beforeEach(() => {
  mocks.listSessions.mockReset();
  useTerminalStore.setState({ sessions: [], hydrated: false });
});
afterEach(() => cleanup());

describe('TerminalSessionsSync → hydrated', () => {
  it('listSessions 返回空快照 → hydrated', async () => {
    mocks.listSessions.mockResolvedValue({ ok: true, data: { sessions: [] } });
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => expect(useTerminalStore.getState().hydrated).toBe(true));
  });

  it('listSessions 返回非空快照 → sessions 与 hydrated 同时可见', async () => {
    mocks.listSessions.mockResolvedValue({ ok: true, data: { sessions: [session('a')] } });
    const seen: Array<[number, boolean]> = [];
    const unsub = useTerminalStore.subscribe((s) => seen.push([s.sessions.length, s.hydrated]));
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => expect(useTerminalStore.getState().hydrated).toBe(true));
    unsub();
    expect(seen.some(([n, h]) => n > 0 && !h)).toBe(false);
  });

  it('listSessions reject → 仍置 hydrated', async () => {
    mocks.listSessions.mockRejectedValue(new Error('ipc down'));
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => expect(useTerminalStore.getState().hydrated).toBe(true));
  });

  it('listSessions {ok:false} → 仍置 hydrated', async () => {
    mocks.listSessions.mockResolvedValue({ ok: false, code: 'EIO' });
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => expect(useTerminalStore.getState().hydrated).toBe(true));
  });

  it('畸形广播不置 hydrated(初始拉取仍在途)', () => {
    mocks.listSessions.mockReturnValue(new Promise(() => {}));
    render(React.createElement(TerminalSessionsSync));
    mocks.emit(null);
    expect(useTerminalStore.getState().hydrated).toBe(false);
  });
});
