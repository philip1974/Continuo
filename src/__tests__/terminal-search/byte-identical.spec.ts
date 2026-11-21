import { describe, expect, it, vi } from 'vitest';
import { terminalSearchReducer as packageReducer } from '@continuo-terminal/react-terminal';
import {
  terminalSearchReducer as wrapperReducer,
  toSearchAddonOptions,
  applyTerminalSearchEffect,
  TERMINAL_SEARCH_DECORATIONS,
  DEFAULT_TERMINAL_SEARCH_OPTIONS,
  INITIAL_TERMINAL_SEARCH_STATE,
  type SearchAddonLike,
  type TerminalSearchState,
} from '@/panels/Terminal/terminal-search-state';

describe('terminal-search wrapper byte-identical', () => {
  describe('T4a reducer reference identity', () => {
    it('Continuo wrapper terminalSearchReducer === package terminalSearchReducer', () => {
      expect(wrapperReducer).toBe(packageReducer);
    });
  });

  describe('T4b state-machine 等价表 (10 case)', () => {
    const baseTermState = (term: string): TerminalSearchState => ({
      ...INITIAL_TERMINAL_SEARCH_STATE,
      term,
    });

    it('open: isOpen=true', () => {
      expect(
        wrapperReducer(INITIAL_TERMINAL_SEARCH_STATE, { type: 'open' })
          .isOpen,
      ).toBe(true);
    });

    it('close: 回 INITIAL', () => {
      const prior = baseTermState('apple');
      expect(wrapperReducer(prior, { type: 'close' })).toEqual(
        INITIAL_TERMINAL_SEARCH_STATE,
      );
    });

    it('setTerm non-empty: 更新 term', () => {
      const next = wrapperReducer(INITIAL_TERMINAL_SEARCH_STATE, {
        type: 'setTerm',
        term: 'apple',
      });
      expect(next.term).toBe('apple');
    });

    it('setTerm empty: 清 term + 重置 result', () => {
      const prior = {
        ...baseTermState('apple'),
        result: { index: 2, count: 5 },
      };
      const next = wrapperReducer(prior, { type: 'setTerm', term: '' });
      expect(next.term).toBe('');
      expect(next.result).toEqual(INITIAL_TERMINAL_SEARCH_STATE.result);
    });

    it('setOptions: 更新 options', () => {
      const next = wrapperReducer(INITIAL_TERMINAL_SEARCH_STATE, {
        type: 'setOptions',
        options: { regex: true, caseSensitive: true, wholeWord: false },
      });
      expect(next.options).toEqual({
        regex: true,
        caseSensitive: true,
        wholeWord: false,
      });
    });

    it('results mounted=true: 更新 result', () => {
      const next = wrapperReducer(INITIAL_TERMINAL_SEARCH_STATE, {
        type: 'results',
        mounted: true,
        result: { index: 1, count: 3 },
      });
      expect(next.result).toEqual({ index: 1, count: 3 });
    });

    it('results mounted=false: 返回原 state object (next === prior + deep equal)', () => {
      const prior = baseTermState('apple');
      const next = wrapperReducer(prior, {
        type: 'results',
        mounted: false,
        result: { index: 1, count: 3 },
      });
      expect(next).toBe(prior);
      expect(next).toEqual(prior);
    });

    it('next: state 不变（with term）', () => {
      const prior = baseTermState('apple');
      expect(wrapperReducer(prior, { type: 'next' })).toBe(prior);
    });

    it('prev: state 不变（with term）', () => {
      const prior = baseTermState('apple');
      expect(wrapperReducer(prior, { type: 'prev' })).toBe(prior);
    });

    it('clearActiveDecoration: state 不变', () => {
      const prior = baseTermState('apple');
      expect(wrapperReducer(prior, { type: 'clearActiveDecoration' })).toBe(
        prior,
      );
    });
  });

  describe('T5 toSearchAddonOptions decoration 注入', () => {
    it('default options 返回的 decorations === TERMINAL_SEARCH_DECORATIONS', () => {
      const result = toSearchAddonOptions(DEFAULT_TERMINAL_SEARCH_OPTIONS);
      expect(result.decorations).toEqual(TERMINAL_SEARCH_DECORATIONS);
    });

    it('options 字段 (regex/caseSensitive/wholeWord) 透传', () => {
      const result = toSearchAddonOptions({
        regex: true,
        caseSensitive: true,
        wholeWord: true,
      });
      expect(result.regex).toBe(true);
      expect(result.caseSensitive).toBe(true);
      expect(result.wholeWord).toBe(true);
    });
  });

  describe('T5b applyTerminalSearchEffect 3 参 wrapper 注入路径', () => {
    function mockAddon(): SearchAddonLike {
      return {
        findNext: vi.fn(() => true),
        findPrevious: vi.fn(() => true),
        clearDecorations: vi.fn(),
        clearActiveDecoration: vi.fn(),
      };
    }

    it('setTerm action: addon.findNext 被调用时 options.decorations === DECORATIONS', () => {
      const addon = mockAddon();
      applyTerminalSearchEffect(addon, INITIAL_TERMINAL_SEARCH_STATE, {
        type: 'setTerm',
        term: 'apple',
      });
      expect(addon.findNext).toHaveBeenCalledWith(
        'apple',
        expect.objectContaining({ decorations: TERMINAL_SEARCH_DECORATIONS }),
      );
    });

    it('next action (with term): addon.findNext 收到 decorations === DECORATIONS', () => {
      const addon = mockAddon();
      const state = { ...INITIAL_TERMINAL_SEARCH_STATE, term: 'apple' };
      applyTerminalSearchEffect(addon, state, { type: 'next' });
      expect(addon.findNext).toHaveBeenCalledWith(
        'apple',
        expect.objectContaining({ decorations: TERMINAL_SEARCH_DECORATIONS }),
      );
    });

    it('prev action (with term): addon.findPrevious 收到 decorations === DECORATIONS', () => {
      const addon = mockAddon();
      const state = { ...INITIAL_TERMINAL_SEARCH_STATE, term: 'apple' };
      applyTerminalSearchEffect(addon, state, { type: 'prev' });
      expect(addon.findPrevious).toHaveBeenCalledWith(
        'apple',
        expect.objectContaining({ decorations: TERMINAL_SEARCH_DECORATIONS }),
      );
    });

    it('close action: addon.clearDecorations 被调', () => {
      const addon = mockAddon();
      applyTerminalSearchEffect(addon, INITIAL_TERMINAL_SEARCH_STATE, {
        type: 'close',
      });
      expect(addon.clearDecorations).toHaveBeenCalledTimes(1);
    });
  });
});
