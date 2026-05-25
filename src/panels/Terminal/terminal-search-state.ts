import type { ISearchOptions } from '@xterm/addon-search';

export interface TerminalSearchOptions {
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
}

export interface TerminalSearchResult {
  readonly index: number;
  readonly count: number;
}

export interface TerminalSearchState {
  readonly isOpen: boolean;
  readonly term: string;
  readonly options: TerminalSearchOptions;
  readonly result: TerminalSearchResult;
}

export interface SearchAddonLike {
  findNext(term: string, searchOptions?: ISearchOptions): boolean;
  findPrevious(term: string, searchOptions?: ISearchOptions): boolean;
  clearDecorations(): void;
  clearActiveDecoration(): void;
}

export type TerminalSearchAction =
  | { readonly type: 'open' }
  | { readonly type: 'close' }
  | { readonly type: 'next' }
  | { readonly type: 'prev' }
  | { readonly type: 'setTerm'; readonly term: string }
  | { readonly type: 'setOptions'; readonly options: TerminalSearchOptions }
  | {
      readonly type: 'results';
      readonly mounted: boolean;
      readonly result: TerminalSearchResult;
    }
  | { readonly type: 'clearActiveDecoration' };

export const DEFAULT_TERMINAL_SEARCH_OPTIONS: TerminalSearchOptions = {
  regex: false,
  caseSensitive: false,
  wholeWord: false,
};

export const INITIAL_TERMINAL_SEARCH_STATE: TerminalSearchState = {
  isOpen: false,
  term: '',
  options: DEFAULT_TERMINAL_SEARCH_OPTIONS,
  result: { index: -1, count: 0 },
};

// Resolved from Continuo theme tokens: accent-fill #2563eb, accent #b4c5ff.
export const TERMINAL_SEARCH_DECORATIONS: NonNullable<
  ISearchOptions['decorations']
> = {
  matchBackground: '#2563eb',
  matchBorder: '#b4c5ff',
  matchOverviewRuler: '#b4c5ff',
  activeMatchBackground: '#b4c5ff',
  activeMatchBorder: '#ffffff',
  activeMatchColorOverviewRuler: '#ffffff',
};

export function toSearchAddonOptions(
  options: TerminalSearchOptions,
): ISearchOptions {
  return {
    decorations: TERMINAL_SEARCH_DECORATIONS,
    regex: options.regex,
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
  };
}

export function terminalSearchReducer(
  state: TerminalSearchState,
  action: TerminalSearchAction,
): TerminalSearchState {
  switch (action.type) {
    case 'open':
      return { ...state, isOpen: true };
    case 'close':
      return INITIAL_TERMINAL_SEARCH_STATE;
    case 'setTerm':
      return {
        ...state,
        term: action.term,
        result:
          action.term.length === 0
            ? INITIAL_TERMINAL_SEARCH_STATE.result
            : state.result,
      };
    case 'setOptions':
      return { ...state, options: action.options };
    case 'results':
      if (!action.mounted) return state;
      return { ...state, result: action.result };
    case 'next':
    case 'prev':
    case 'clearActiveDecoration':
      return state;
  }
}

export function applyTerminalSearchEffect(
  addon: SearchAddonLike | null,
  state: TerminalSearchState,
  action: TerminalSearchAction,
): void {
  if (!addon) return;
  if (action.type === 'close') {
    addon.clearDecorations();
    return;
  }
  if (action.type === 'clearActiveDecoration') {
    addon.clearActiveDecoration();
    return;
  }
  if (action.type === 'setTerm') {
    if (action.term.length === 0) {
      addon.clearDecorations();
      return;
    }
    addon.findNext(action.term, toSearchAddonOptions(state.options));
    return;
  }
  if (action.type === 'setOptions' && state.term.length > 0) {
    addon.findNext(state.term, toSearchAddonOptions(action.options));
    return;
  }
  if (action.type === 'next' && state.term.length > 0) {
    addon.findNext(state.term, toSearchAddonOptions(state.options));
    return;
  }
  if (action.type === 'prev' && state.term.length > 0) {
    addon.findPrevious(state.term, toSearchAddonOptions(state.options));
  }
}

export interface ActivePanelLike {
  readonly id: string;
  readonly view: { readonly contentComponent?: string };
}

export function getActiveTerminalPanelId(api: {
  readonly activePanel?: ActivePanelLike | null;
}): string | null {
  const active = api.activePanel;
  if (!active || active.view.contentComponent !== 'terminal') return null;
  return active.id;
}
