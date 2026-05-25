import { describe, expect, it, vi } from 'vitest';
import {
  INITIAL_TERMINAL_SEARCH_STATE,
  applyTerminalSearchEffect,
  getActiveTerminalPanelId,
  terminalSearchReducer,
  type SearchAddonLike,
} from '@/panels/Terminal/terminal-search-state';

function addon(): SearchAddonLike {
  return {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    clearActiveDecoration: vi.fn(),
  };
}

describe('terminal search state machine', () => {
  it('S2 setTerm with query searches next with decorations', () => {
    const a = addon();
    const state = terminalSearchReducer(INITIAL_TERMINAL_SEARCH_STATE, {
      type: 'setTerm',
      term: 'error',
    });

    applyTerminalSearchEffect(a, state, {
      type: 'setTerm',
      term: 'error',
    });

    expect(state.term).toBe('error');
    expect(a.findNext).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ decorations: expect.any(Object) }),
    );
  });

  it('S3 empty query clears decorations and result state', () => {
    const a = addon();
    const prior = {
      ...INITIAL_TERMINAL_SEARCH_STATE,
      term: 'error',
      result: { index: 1, count: 3 },
    };
    const state = terminalSearchReducer(prior, { type: 'setTerm', term: '' });

    applyTerminalSearchEffect(a, state, { type: 'setTerm', term: '' });

    expect(state.result).toEqual({ index: -1, count: 0 });
    expect(a.clearDecorations).toHaveBeenCalledTimes(1);
  });

  it('S4 next and previous navigate with current term', () => {
    const a = addon();
    const state = { ...INITIAL_TERMINAL_SEARCH_STATE, term: 'error' };

    applyTerminalSearchEffect(a, state, { type: 'next' });
    applyTerminalSearchEffect(a, state, { type: 'prev' });

    expect(a.findNext).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ decorations: expect.any(Object) }),
    );
    expect(a.findPrevious).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ decorations: expect.any(Object) }),
    );
  });

  it('S5 setOptions reruns search with updated options', () => {
    const a = addon();
    const state = terminalSearchReducer(
      { ...INITIAL_TERMINAL_SEARCH_STATE, term: 'error' },
      {
        type: 'setOptions',
        options: { regex: true, caseSensitive: true, wholeWord: false },
      },
    );

    applyTerminalSearchEffect(a, state, {
      type: 'setOptions',
      options: state.options,
    });

    expect(a.findNext).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        regex: true,
        caseSensitive: true,
        wholeWord: false,
        decorations: expect.any(Object),
      }),
    );
  });

  it('S6 close clears query, decorations, and result state', () => {
    const a = addon();
    const prior = {
      ...INITIAL_TERMINAL_SEARCH_STATE,
      isOpen: true,
      term: 'error',
      result: { index: 0, count: 1 },
    };
    const state = terminalSearchReducer(prior, { type: 'close' });

    applyTerminalSearchEffect(a, state, { type: 'close' });

    expect(state).toEqual(INITIAL_TERMINAL_SEARCH_STATE);
    expect(a.clearDecorations).toHaveBeenCalledTimes(1);
  });

  it('S7 blur clears only active decoration', () => {
    const a = addon();

    applyTerminalSearchEffect(a, INITIAL_TERMINAL_SEARCH_STATE, {
      type: 'clearActiveDecoration',
    });

    expect(a.clearActiveDecoration).toHaveBeenCalledTimes(1);
    expect(a.clearDecorations).not.toHaveBeenCalled();
  });

  it('S9 ignores late result events after unmount', () => {
    const prior = {
      ...INITIAL_TERMINAL_SEARCH_STATE,
      result: { index: 0, count: 2 },
    };
    const state = terminalSearchReducer(prior, {
      type: 'results',
      mounted: false,
      result: { index: 4, count: 9 },
    });

    expect(state.result).toEqual({ index: 0, count: 2 });
  });

  it('S10 resolves only active terminal panel for command scoping', () => {
    expect(
      getActiveTerminalPanelId({
        activePanel: { id: 'terminal-1', view: { contentComponent: 'terminal' } },
      }),
    ).toBe('terminal-1');
    expect(
      getActiveTerminalPanelId({
        activePanel: { id: 'editor', view: { contentComponent: 'editor' } },
      }),
    ).toBeNull();
    expect(getActiveTerminalPanelId({ activePanel: null })).toBeNull();
  });
});
