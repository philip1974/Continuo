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
import { coApi } from '../../lib/co-api';

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
    // 与 Output 等面板同一空态(design EmptyState):居中、无边框卡片。
    expect(container.querySelector('.wm-empty-state')?.textContent).toBe('No debug session');
    expect(container.querySelector('.wm-card')).toBeNull();
  });

  it('renders stack, variables, and breakpoint sections with design components', async () => {
    useDebugStore.setState({
      activeSessionId: 's1',
      sessions: new Map([
        [
          's1',
          {
            id: 's1',
            label: 'prog.js',
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
    // 会话标题用会话名(程序名),不显示内部 id。
    expect(screen.getByText('prog.js')).toBeTruthy();
    expect(screen.queryByText('s1')).toBeNull();
    // 位置(停点行与栈帧)以「文件名:行号」为主,父目录弱化并从前截断(完整路径在 title)。
    expect(screen.getAllByText('a.ts:14')).toHaveLength(2);
    const parents = Array.from(container.querySelectorAll<HTMLElement>('.wm-truncate-start'));
    expect(parents.map((el) => el.textContent)).toEqual(['/repo', '/repo']);
    expect(parents.every((el) => el.title === '/repo/a.ts:14')).toBe(true);
    expect(container.querySelector('.wm-tabs')).toBeTruthy();
    expect(container.querySelector('.wm-card')).toBeTruthy();
    expect(container.querySelector('.wm-badge')).toBeTruthy();
    expect(container.querySelector('.wm-scroll-area')).toBeTruthy();

    // 第一个作用域进入变量页即自动加载(不必点「Load Local」),加载后按钮收起。
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    await waitFor(() => expect(screen.getByText('sum')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Load Local' })).toBeNull();
    expect(screen.getByText('21')).toBeTruthy();
    // 不满页(无 next_start)→ 不显示「加载更多」。
    expect(screen.queryByRole('treeitem', { name: 'Load more' })).toBeNull();

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

  // 满页(next_start)→ 显示「加载更多」,点击把下一页追加到同一作用域下;末页后按钮消失。
  it('变量满页 → 显示 Load more,点击追加第二页', async () => {
    const getVariables = vi.mocked(coApi.debug.getVariables);
    getVariables
      .mockResolvedValueOnce({
        ok: true,
        data: { variables: [{ name: 'first', value: '1', variables_reference: 0 }], truncated: true, next_start: 1 },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { variables: [{ name: 'second', value: '2', variables_reference: 0 }], truncated: false },
      });
    useDebugStore.setState({
      activeSessionId: 's1',
      sessions: new Map([
        [
          's1',
          {
            id: 's1',
            breakpoints: [],
            frames: [],
            scopes: [{ name: 'Local', variables_reference: 44, expensive: false }],
            variableRefs: new Map(),
            stopped: { reason: 'breakpoint', stopSeq: 1 },
            lastStoppedOrder: 1,
          },
        ],
      ]),
    });
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Variables' }));
    await waitFor(() => expect(screen.getByText('first')).toBeTruthy());

    fireEvent.click(screen.getByRole('treeitem', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('second')).toBeTruthy());
    expect(screen.getByText('first')).toBeTruthy();
    expect(getVariables).toHaveBeenLastCalledWith({ sessionId: 's1', variablesReference: 44, start: 1 });
    expect(screen.queryByRole('treeitem', { name: 'Load more' })).toBeNull();
  });
});
