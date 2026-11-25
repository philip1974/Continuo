// @vitest-environment jsdom
// S2c 输入搜索词 / 切换选项:从底部(最近输出)向上增量搜索,先落最近的匹配(VSCode TerminalFindWidget._onInputChanged:
// findPrevious + incremental),视口不被拉到回滚区顶部;终端搜索条 Enter 向上(findPrevious)、⇧Enter 向下(VSCode 终端查找
// 绑定),编辑器查找(缺省)仍 Enter 向下。
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_TERMINAL_SEARCH_STATE,
  applyTerminalSearchEffect,
  type SearchAddonLike,
} from '@/panels/Terminal/terminal-search-state';
import { TerminalSearchBar } from '@/panels/Terminal/TerminalSearchBar';
import type { SearchApi } from '@/panels/Terminal/useTerminal';

function addon() {
  return {
    findNext: vi.fn((_term: string, _options?: object) => true),
    findPrevious: vi.fn((_term: string, _options?: object) => true),
    clearDecorations: vi.fn(),
    clearActiveDecoration: vi.fn(),
  } satisfies SearchAddonLike;
}

afterEach(() => cleanup());

describe('S2c 输入时从底部向上增量搜索', () => {
  it('setTerm → findPrevious(incremental),不调 findNext(从顶部往下会先落最旧的匹配)', () => {
    const a = addon();
    applyTerminalSearchEffect(a, INITIAL_TERMINAL_SEARCH_STATE, { type: 'setTerm', term: '1999' });
    expect(a.findPrevious).toHaveBeenCalledWith('1999', expect.objectContaining({ incremental: true }));
    expect(a.findNext).not.toHaveBeenCalled();
  });

  it('切换选项同样按新选项向上增量重搜;空词不搜', () => {
    const a = addon();
    const state = { ...INITIAL_TERMINAL_SEARCH_STATE, term: 'err' };
    const options = { regex: false, caseSensitive: true, wholeWord: false };
    applyTerminalSearchEffect(a, state, { type: 'setOptions', options });
    expect(a.findPrevious).toHaveBeenCalledWith(
      'err',
      expect.objectContaining({ caseSensitive: true, incremental: true }),
    );
    a.findPrevious.mockClear();
    applyTerminalSearchEffect(a, INITIAL_TERMINAL_SEARCH_STATE, { type: 'setOptions', options });
    applyTerminalSearchEffect(a, state, { type: 'setTerm', term: '' });
    expect(a.findPrevious).not.toHaveBeenCalled();
    expect(a.findNext).not.toHaveBeenCalled();
  });

  it('上一个 / 下一个跳转不是增量(从当前匹配移开)', () => {
    const a = addon();
    const state = { ...INITIAL_TERMINAL_SEARCH_STATE, term: 'err' };
    applyTerminalSearchEffect(a, state, { type: 'next' });
    applyTerminalSearchEffect(a, state, { type: 'prev' });
    expect(a.findNext.mock.calls[0]?.[1]).not.toHaveProperty('incremental');
    expect(a.findPrevious.mock.calls[0]?.[1]).not.toHaveProperty('incremental');
  });
});

function makeApi(): SearchApi {
  return {
    isOpen: true,
    term: 'x',
    options: { regex: false, caseSensitive: false, wholeWord: false },
    result: { index: -1, count: 0 },
    focusRequest: 1,
    open: vi.fn(),
    close: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    setTerm: vi.fn(),
    setOptions: vi.fn(),
    clearActiveDecoration: vi.fn(),
  };
}

describe('S4c 终端搜索条 Enter 向上、⇧Enter 向下', () => {
  it('enterFindsPrevious:Enter → prev,⇧Enter → next', () => {
    const api = makeApi();
    const { getByRole } = render(<TerminalSearchBar searchApi={api} onClose={vi.fn()} enterFindsPrevious />);
    const input = getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.prev).toHaveBeenCalledTimes(1);
    expect(api.next).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(api.next).toHaveBeenCalledTimes(1);
  });

  it('缺省(编辑器查找复用)Enter 仍向下', () => {
    const api = makeApi();
    const { getByRole } = render(<TerminalSearchBar searchApi={api} onClose={vi.fn()} />);
    fireEvent.keyDown(getByRole('textbox'), { key: 'Enter' });
    expect(api.next).toHaveBeenCalledTimes(1);
    expect(api.prev).not.toHaveBeenCalled();
  });

  it('终端面板给搜索条传 enterFindsPrevious(源码钉)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/panels/Terminal/TerminalPanelView.tsx', 'utf8');
    expect(src).toMatch(/<TerminalSearchBar[^>]*\benterFindsPrevious\b/);
  });
});
