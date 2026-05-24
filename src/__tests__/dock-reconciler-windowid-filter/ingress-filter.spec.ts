// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { TerminalSessionsSync } from '../../shell/dock/TerminalSessionsSync';
import {
  useTerminalStore,
  type TerminalSession,
} from '../../stores/terminal.store';
import { makeSession } from './fixtures';

let warnSpy: ReturnType<typeof vi.spyOn>;

const mocks = vi.hoisted(() => {
  let onChanged: ((sessions: unknown[]) => void) | null = null;
  const unsubscribe = vi.fn();
  return {
    windowId: 1 as number | undefined,
    listSessions: vi.fn(),
    onSessionsChanged: vi.fn((cb: (sessions: unknown[]) => void) => {
      onChanged = cb;
      return unsubscribe;
    }),
    emitSessionsChanged: (sessions: unknown[]) => onChanged?.(sessions),
    unsubscribe,
    create: vi.fn(),
    remove: vi.fn(),
  };
});

vi.mock('@/lib/co-api', () => ({
  coApi: {
    system: {
      get windowId() {
        return mocks.windowId;
      },
    },
    terminal: {
      listSessions: mocks.listSessions,
      onSessionsChanged: mocks.onSessionsChanged,
      create: mocks.create,
      remove: mocks.remove,
    },
  },
}));

vi.mock('../../panels/Terminal/useTerminal', () => ({
  useTerminal: () => ({ containerRef: { current: null }, isReady: true }),
}));

vi.mock('../../panels/Terminal/TerminalView', () => ({
  TerminalView: ({ termId }: { termId: string }) =>
    React.createElement('div', { 'data-testid': `terminal-view-${termId}` }),
}));

beforeEach(async () => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.windowId = 1;
  mocks.listSessions.mockReset();
  mocks.listSessions.mockResolvedValue({ ok: true, data: { sessions: [] } });
  mocks.onSessionsChanged.mockClear();
  mocks.unsubscribe.mockReset();
  useTerminalStore.setState({
    sessions: [],
    activeId: null,
    customTitles: new Map(),
  });
  const sync = await import('../../shell/dock/TerminalSessionsSync');
  sync._resetTerminalDropWarningsForTest();
});

afterEach(() => {
  warnSpy.mockRestore();
  cleanup();
});

describe('dock-reconciler-windowid-filter: renderer ingress filter', () => {
  it('T11 TerminalSessionsSync listSessions 响应 -> useTerminalStore.replaceSnapshot 收到 filtered', async () => {
    mocks.listSessions.mockResolvedValue({
      ok: true,
      data: { sessions: [makeSession('A'), makeSession('B', { ownerWindowId: 2 })] },
    });
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(useTerminalStore.getState().sessions.map((s) => s.id)).toEqual([
        'A',
      ]);
    });
  });

  it('T12 TerminalSessionsSync onSessionsChanged 多次 -> 持续 filtered', async () => {
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(mocks.onSessionsChanged).toHaveBeenCalledTimes(1);
    });
    mocks.emitSessionsChanged([makeSession('A'), makeSession('B', { ownerWindowId: 2 })]);
    expect(useTerminalStore.getState().sessions.map((s) => s.id)).toEqual([
      'A',
    ]);
    mocks.emitSessionsChanged([makeSession('C', { ownerWindowId: 2 }), makeSession('D')]);
    expect(useTerminalStore.getState().sessions.map((s) => s.id)).toEqual([
      'D',
    ]);
  });

  // T13/T14 删除:LegacyTerminalPanel 已从代码库移除(commit 后续)。
  // T11/T12 在 TerminalSessionsSync 层已覆盖同一 ingress filter invariant。
});
