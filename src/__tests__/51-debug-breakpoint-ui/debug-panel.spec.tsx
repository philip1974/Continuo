// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../lib/co-api', () => ({
  coApi: {
    debug: {
      onEvent: vi.fn(() => () => undefined),
      subscribe: vi.fn(async () => ({ ok: true, data: { sessions: [] } })),
      getStack: vi.fn(),
      getVariables: vi.fn(async () => ({
        ok: true,
        data: {
          variables: [{ name: 'sum', value: '21', variables_reference: 0 }],
          truncated: false,
        },
      })),
    },
  },
}));

import { DebugPanel } from '../../panels/Debug/DebugPanel';
import {
  resetDebugStoreForTest,
  useDebugStore,
} from '../../stores/debug.store';
import { setLocale } from '../../i18n';

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  resetDebugStoreForTest();
  setLocale('en');
});

describe('topic51 Op5 · DebugPanel', () => {
  it('renders an empty state through design surfaces', () => {
    const { container } = render(<DebugPanel />);

    expect(screen.getByText('No debug session')).toBeTruthy();
    expect(container.querySelector('.wm-card')).toBeTruthy();
  });

  it('renders stack, variables, and breakpoint sections with design components', async () => {
    useDebugStore.setState({
      activeSessionId: 's1',
      sessions: new Map([
        [
          's1',
          {
            id: 's1',
            breakpoints: [{ file: '/repo/a.ts', line: 14, verified: true }],
            frames: [
              {
                id: 7,
                name: 'main',
                source_path: '/repo/a.ts',
                line: 14,
                column: 1,
              },
            ],
            scopes: [{ name: 'Local', variables_reference: 44, expensive: false }],
            variableRefs: new Map(),
            stopped: {
              reason: 'breakpoint',
              stopSeq: 1,
              file: '/repo/a.ts',
              line: 14,
            },
            lastStoppedOrder: 1,
          },
        ],
      ]),
    });

    const { container } = render(<DebugPanel />);

    expect(screen.getByText('Call Stack')).toBeTruthy();
    expect(screen.getByText('Variables')).toBeTruthy();
    expect(screen.getByText('Breakpoints')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.getAllByText('/repo/a.ts:14')).toHaveLength(2);
    expect(container.querySelector('.wm-tabs')).toBeTruthy();
    expect(container.querySelector('.wm-card')).toBeTruthy();
    expect(container.querySelector('.wm-badge')).toBeTruthy();
    expect(container.querySelector('.wm-scroll-area')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load Local' }));
    await waitFor(() => expect(screen.getByText('sum')).toBeTruthy());
    expect(screen.getByText('21')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Breakpoints' }));
    expect(screen.getByText('verified')).toBeTruthy();
  });

  // activeSessionId 只指向已停下的会话;会话 continue 后面板仍显示该(运行中)会话与其断点,而非「无调试会话」。
  it('会话运行中(未停)→ 显示该会话、徽章「running」、断点页可进,不显示「No debug session」', () => {
    useDebugStore.setState({
      activeSessionId: null,
      sessions: new Map([
        [
          's2',
          {
            id: 's2',
            breakpoints: [{ file: '/repo/b.ts', line: 3, verified: true }],
            frames: [],
            scopes: [],
            variableRefs: new Map(),
            lastStoppedOrder: 0,
          },
        ],
      ]),
    });
    render(<DebugPanel />);
    expect(screen.queryByText('No debug session')).toBeNull();
    expect(screen.getByText('s2')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Breakpoints' }));
    expect(screen.getByText('verified')).toBeTruthy();
  });
});

