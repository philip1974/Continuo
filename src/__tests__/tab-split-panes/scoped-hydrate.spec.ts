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

const existing: TerminalSession = {
  id: 'legacy-1',
  title: 'Legacy',
  cwd: '/repo',
  originHint: 'user',
  createdAt: 0,
  exitCode: null,
};

describe('tab split panes - scoped hydrate', () => {
  beforeEach(() => {
    _resetLmApiForTest();
    useTerminalStore.setState({ sessions: [existing], activeId: 'legacy-1' });
  });

  afterEach(() => {
    delete (window as { api?: unknown }).api;
    cleanup();
    vi.restoreAllMocks();
  });

  it('creates a scoped terminal from cwd/title params and writes the new sessionId back to panel params', async () => {
    const updateParameters = vi.fn();
    const create = vi.fn().mockResolvedValue({ ok: true, data: { id: 'term-new' } });
    Object.defineProperty(window, 'api', {
      value: {
        terminal: {
          create,
          remove: vi.fn(),
          listSessions: vi.fn(() => new Promise(() => {})),
          onSessionsChanged: vi.fn(() => vi.fn()),
        },
      },
      configurable: true,
    });
    captureLmApi();

    render(
      React.createElement(TerminalPanel as React.ComponentType<any>, {
        params: { cwd: '/repo/packages/app', title: 'Split A' },
        api: { updateParameters },
      }),
    );

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        cwd: '/repo/packages/app',
        title: 'Split A',
        scoped: true,
      });
      expect(updateParameters).toHaveBeenCalledWith({ sessionId: 'term-new' });
    });
  });
});
