// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../panels/Terminal/useTerminal', () => ({
  useTerminal: () => ({ containerRef: { current: null }, isReady: true }),
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { TerminalPanel } from '../../panels/Terminal/TerminalPanel';
import { useTerminalStore, type TerminalSession } from '../../stores/terminal.store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const existing: TerminalSession = {
  id: 'legacy-1',
  title: 'Legacy',
  cwd: '/repo',
  originHint: 'user',
  createdAt: 0,
  exitCode: null,
};

describe('tab split panes - scoped hydrate cancelled cleanup', () => {
  beforeEach(() => {
    _resetLmApiForTest();
    useTerminalStore.setState({ sessions: [existing], activeId: 'legacy-1' });
  });

  afterEach(() => {
    delete (window as { api?: unknown }).api;
    cleanup();
    vi.restoreAllMocks();
  });

  it('removes a created scoped terminal if the panel unmounts while hydrate is in flight', async () => {
    const createResult = deferred<{ ok: true; data: { id: string } }>();
    const remove = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'api', {
      value: {
        terminal: {
          create: vi.fn(() => createResult.promise),
          remove,
          listSessions: vi.fn(() => new Promise(() => {})),
          onSessionsChanged: vi.fn(() => vi.fn()),
        },
      },
      configurable: true,
    });
    captureLmApi();

    const { unmount } = render(
      React.createElement(TerminalPanel as React.ComponentType<any>, {
        params: { cwd: '/repo', title: 'Split' },
        api: { updateParameters: vi.fn() },
      }),
    );
    unmount();
    createResult.resolve({ ok: true, data: { id: 'term-created-after-unmount' } });

    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith('term-created-after-unmount');
    });
  });
});
