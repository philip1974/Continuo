// @vitest-environment jsdom
// 打磨 R40(codex 性能,延续 R22/R24/R39):TerminalPanelView 改为订阅派生 primitive
// (title/originHint/exists)而非整个 session 对象。main 推 snapshot 带来新 session
// 对象引用(别的 session 或 exit 状态变化)不再让终端面板 wrapper 重渲。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Profiler } from 'react';
import { render, cleanup, act } from '@testing-library/react';

// mock 重型 xterm 相关,让 TerminalPanelContent 轻量渲染
vi.mock('../../panels/Terminal/useTerminal', () => ({
  useTerminal: () => ({
    containerRef: { current: null },
    isReady: true,
    fit: vi.fn(),
    focus: vi.fn(),
    searchApi: { open: vi.fn(), close: vi.fn(), isOpen: false },
  }),
}));
vi.mock('../../panels/Terminal/useTerminalDragDrop', () => ({
  useTerminalDragDrop: () => ({ ref: { current: null } }),
}));
vi.mock('../../panels/Terminal/terminal-focus-registry', () => ({
  registerTerminalFocus: () => vi.fn(),
}));
vi.mock('../../panels/Terminal/terminal-search-registry', () => ({
  registerTerminalSearch: () => ({ dispose: vi.fn() }),
}));
vi.mock('../../panels/Terminal/TerminalSearchBar', () => ({
  TerminalSearchBar: () => null,
}));

import { TerminalPanelView } from '../../panels/Terminal/TerminalPanelView';
import { useTerminalStore } from '../../stores/terminal.store';

function sess(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    cwd: '/',
    originHint: 'user' as const,
    createdAt: 0,
    exitCode: null,
    ownerWindowId: 1,
    ...over,
  };
}

function makeProps(sessionId: string): Parameters<typeof TerminalPanelView>[0] {
  return {
    api: {
      id: 'panel-1',
      title: '',
      close: vi.fn(),
      setTitle: vi.fn(function (this: { title: string }, tt: string) {
        this.title = tt;
      }),
      onDidActiveChange: () => ({ dispose: vi.fn() }),
      onDidDimensionsChange: () => ({ dispose: vi.fn() }),
      onDidVisibilityChange: () => ({ dispose: vi.fn() }),
    },
    params: { sessionId },
  } as unknown as Parameters<typeof TerminalPanelView>[0];
}

beforeEach(() => {
  useTerminalStore.setState({
    sessions: [sess('t1', { title: 'My Term' }), sess('t2')],
    activeId: 't1',
    customTitles: new Map(),
  });
});
afterEach(() => cleanup());

describe('打磨 R40 — TerminalPanelView 订阅派生 title primitive', () => {
  it('按 sessionId 查标题走索引缓存,不调用 sessions.find', () => {
    const sessions = useTerminalStore.getState().sessions;
    const findSpy = vi.spyOn(sessions, 'find');

    try {
      render(<TerminalPanelView {...makeProps('t1')} />);
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  it('无关字段(exitCode)变化 → 面板不重渲', () => {
    const onRender = vi.fn();
    render(
      <Profiler id="tpv" onRender={onRender}>
        <TerminalPanelView {...makeProps('t1')} />
      </Profiler>,
    );
    const base = onRender.mock.calls.length;
    expect(base).toBeGreaterThan(0);

    // 改 t1 的 exitCode(与 title/originHint 无关)+ 改别的 session
    act(() => {
      useTerminalStore.setState((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === 't1' ? { ...x, exitCode: 0 } : x,
        ),
      }));
    });

    expect(onRender.mock.calls.length).toBe(base); // 无新 commit
  });

  it('title 变化 → 重渲', () => {
    const onRender = vi.fn();
    render(
      <Profiler id="tpv" onRender={onRender}>
        <TerminalPanelView {...makeProps('t1')} />
      </Profiler>,
    );
    const base = onRender.mock.calls.length;

    act(() => {
      useTerminalStore.setState((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === 't1' ? { ...x, title: 'Renamed' } : x,
        ),
      }));
    });

    expect(onRender.mock.calls.length).toBeGreaterThan(base);
  });
});
