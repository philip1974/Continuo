// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../panels/Terminal/useTerminal', () => ({
  useTerminal: () => ({ containerRef: { current: null }, isReady: true }),
}));

vi.mock('../../panels/Terminal/TerminalView', () => ({
  TerminalView: ({ termId }: { termId: string }) =>
    React.createElement('div', { 'data-testid': `terminal-view-${termId}` }, termId),
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { TerminalPanel } from '../../panels/Terminal/TerminalPanel';
import { useTerminalStore, type TerminalSession } from '../../stores/terminal.store';

function session(id: string): TerminalSession {
  return {
    id,
    title: id,
    cwd: '/repo',
    originHint: 'user',
    createdAt: 0,
    exitCode: null,
  };
}

describe('tab split panes - scoped session render', () => {
  beforeEach(() => {
    _resetLmApiForTest();
    Object.defineProperty(window, 'api', {
      value: {
        terminal: {
          create: vi.fn(),
          remove: vi.fn(),
          listSessions: vi.fn(() => new Promise(() => {})),
          onSessionsChanged: vi.fn(() => vi.fn()),
        },
      },
      configurable: true,
    });
    captureLmApi();
    useTerminalStore.setState({
      sessions: [session('legacy-1'), session('scoped-1')],
      activeId: 'legacy-1',
    });
  });

  afterEach(() => {
    delete (window as { api?: unknown }).api;
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders only the session named by Dockview params when the panel is scoped', () => {
    render(
      React.createElement(TerminalPanel as React.ComponentType<any>, {
        params: { sessionId: 'scoped-1', cwd: '/repo', title: 'Split' },
        api: { updateParameters: vi.fn() },
      }),
    );

    expect(screen.getByTestId('terminal-view-scoped-1')).not.toBeNull();
    expect(screen.queryByTestId('terminal-view-legacy-1')).toBeNull();
  });
});
