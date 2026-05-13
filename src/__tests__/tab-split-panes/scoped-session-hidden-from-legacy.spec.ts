// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalTabs } from '../../panels/Terminal/TerminalTabs';
import { useTerminalStore, type TerminalSession } from '../../stores/terminal.store';

function session(id: string, title: string, scoped: boolean): TerminalSession & { scoped: boolean } {
  return {
    id,
    title,
    cwd: '/repo',
    originHint: 'user',
    createdAt: 0,
    exitCode: null,
    scoped,
  };
}

describe('tab split panes - scoped session hidden from legacy tabs', () => {
  beforeEach(() => {
    useTerminalStore.setState({
      sessions: [
        session('legacy-1', 'Legacy Terminal', false),
        session('split-1', 'Scoped Split', true),
      ],
      activeId: 'legacy-1',
      customTitles: new Map(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('filters scoped sessions out of the legacy TerminalTabs list', () => {
    render(
      React.createElement(TerminalTabs, {
        onNewSession: vi.fn(),
        onCloseSession: vi.fn(),
        showTabList: true,
      }),
    );

    expect(screen.getByText('Legacy Terminal')).not.toBeNull();
    expect(screen.queryByText('Scoped Split')).toBeNull();
  });
});
