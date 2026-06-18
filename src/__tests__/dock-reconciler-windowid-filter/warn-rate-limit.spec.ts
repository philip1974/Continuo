// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import {
  TerminalSessionsSync,
  _resetTerminalDropWarningsForTest,
} from '../../shell/dock/TerminalSessionsSync';
import { useTerminalStore } from '../../stores/terminal.store';
import { makeSession } from './fixtures';

const mocks = vi.hoisted(() => {
  let onChanged: ((sessions: unknown[]) => void) | null = null;
  const unsubscribe = vi.fn();
  return {
    listSessions: vi.fn(),
    onSessionsChanged: vi.fn((cb: (sessions: unknown[]) => void) => {
      onChanged = cb;
      return unsubscribe;
    }),
    emitSessionsChanged: (sessions: unknown[]) => onChanged?.(sessions),
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

beforeEach(() => {
  _resetTerminalDropWarningsForTest();
  mocks.listSessions.mockReset();
  mocks.listSessions.mockResolvedValue({ ok: true, data: { sessions: [] } });
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

describe('dock-reconciler-windowid-filter: warn rate limit', () => {
  it('T20 同 sessionId+reason 多次推送 -> console.warn 调一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(React.createElement(TerminalSessionsSync));
    await waitFor(() => {
      expect(mocks.onSessionsChanged).toHaveBeenCalledTimes(1);
    });
    mocks.emitSessionsChanged([makeSession('B', { ownerWindowId: 2 })]);
    mocks.emitSessionsChanged([makeSession('B', { ownerWindowId: 2 })]);
    mocks.emitSessionsChanged([makeSession('B', { ownerWindowId: 2 })]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('wrong-owner');
    expect(warn.mock.calls[0]?.[1]).toBe('B');
    warn.mockRestore();
  });
});
