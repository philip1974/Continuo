// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const clipboard = vi.hoisted(() => ({ writeText: (async () => undefined) as (text: string) => Promise<void> }));
vi.mock('../../plugins/sandbox-sweep', () => ({
  getCachedFetch: () => globalThis.fetch,
  getCachedClipboard: () => ({
    readText: () => Promise.resolve(''),
    writeText: (text: string) => clipboard.writeText(text),
  }),
  sandboxSweep: () => {},
}));

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
import { setLocale, t } from '../../i18n';
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
    expect(container.querySelector('.wm-empty-state')?.textContent).toContain('No debug session');
    expect(container.querySelector('.wm-card')).toBeNull();
  });

  // 空态给出下一步:调试会话由 Agent 经 MCP 调试工具启动(Continuo 没有自己的启动配置)→ 说明 + 「复制 MCP 配置」
  //(与状态栏同一动作与成功 / 失败反馈)。
  it('empty state explains that agents start sessions via MCP and offers Copy MCP config', async () => {
    const getStdioConfig = vi.fn(async () => ({ ok: true, data: { claudeAddCommand: 'claude mcp add continuo' } }));
    const writeText = vi.fn(async () => undefined);
    (coApi as unknown as { mcp: unknown }).mcp = { getStdioConfig };
    clipboard.writeText = writeText;
    render(<DebugPanel />);

    expect(screen.getByText(t('panels.debug.empty_hint'))).toBeTruthy();
    const btn = screen.getByRole('button', { name: t('statusbar.mcp.copy') });
    fireEvent.click(btn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('claude mcp add continuo'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(t('statusbar.mcp.copied')));
    expect(btn.textContent).toBe(t('statusbar.mcp.copied'));
  });

  it('Copy MCP config failure reports the same failure text as the status bar', async () => {
    (coApi as unknown as { mcp: unknown }).mcp = { getStdioConfig: vi.fn(async () => ({ ok: false, code: 'X' })) };
    render(<DebugPanel />);
    fireEvent.click(screen.getByRole('button', { name: t('statusbar.mcp.copy') }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(t('statusbar.mcp.copy_failed')));
  });

  it.each(['zh', 'ko'] as const)('empty state hint is localized (%s)', (locale) => {
    setLocale(locale);
    render(<DebugPanel />);
    expect(screen.getByText(t('panels.debug.empty_hint'))).toBeTruthy();
    expect(t('panels.debug.empty_hint')).not.toMatch(/Debug sessions are started/);
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

  // VSCode 调用栈给打不开的帧(无源码 / 内部伪路径)加 .disabled 弱化;这里改非交互元素 + 斜体 + 弱化文字色,不叠透明度
  //(禁用按钮 opacity 0.5 把路径压到 2.34:1)。
  it('打不开的帧不是按钮:非交互元素、斜体、名称 fg-muted、不带 opacity;可打开的帧仍是按钮', () => {
    useDebugStore.setState({
      activeSessionId: 's1',
      sessions: new Map([
        [
          's1',
          {
            id: 's1',
            label: 'prog.js',
            breakpoints: [],
            frames: [
              { id: 1, name: 'main', source_path: '/repo/a.ts', line: 3, column: 1 },
              { id: 2, name: 'Module._compile', source_path: 'node:internal/modules/cjs/loader', line: 1872, column: 1 },
            ],
            scopes: [],
            variableRefs: new Map(),
            stopped: { reason: 'breakpoint', stopSeq: 1, file: '/repo/a.ts', line: 3 },
            lastStoppedOrder: 1,
          },
        ],
      ]),
    });
    render(<DebugPanel />);
    const openable = screen.getByText('main').closest('button');
    expect(openable).not.toBeNull();
    expect(openable!.disabled).toBe(false);
    const name = screen.getByText('Module._compile');
    expect(name.closest('button')).toBeNull();
    const row = name.closest<HTMLElement>('[data-deemphasized]');
    expect(row).not.toBeNull();
    expect(row!.className.split(/\s+/)).toContain('italic');
    expect(row!.className).not.toMatch(/opacity/);
    expect(name.className.split(/\s+/)).toContain('text-fg-muted');
    expect(row!.title).toBe('node:internal/modules/cjs/loader:1872');
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
