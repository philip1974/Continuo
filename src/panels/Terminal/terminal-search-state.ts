// Continuo-local thin wrapper for @continuo-terminal/react-terminal search-state.
// Re-exports package types/reducer/effect with explicit named exports (not `export *`)
// to avoid leaking the package's 4-arg applyTerminalSearchEffect into Continuo call sites.
// host-specific bindings (DECORATIONS palette, dockview activePanel resolver) stay here.
//
// Migrated per dev-loop topic 25.

// Type re-exports
export type {
  TerminalSearchOptions,
  TerminalSearchResult,
  TerminalSearchState,
  TerminalSearchAction,
  SearchAddonLike,
} from '@continuo-terminal/react-terminal';

// Value re-exports
export {
  terminalSearchReducer,
  INITIAL_TERMINAL_SEARCH_STATE,
  DEFAULT_TERMINAL_SEARCH_OPTIONS,
} from '@continuo-terminal/react-terminal';

import {
  applyTerminalSearchEffect as packageApply,
  toSearchAddonOptions as packageToOpts,
  type TerminalSearchOptions,
  type SearchAddonLike,
  type TerminalSearchAction,
  type TerminalSearchState,
} from '@continuo-terminal/react-terminal';
import type { ISearchOptions } from '@xterm/addon-search';
import { TERMINAL_PANEL_TYPE } from './constants';

// legacy literal hex — 后续 token 化 follow-up topic（plan-v4 P1-3 决议留 wrapper 不进 constants.ts）
// Resolved from Continuo theme tokens: accent-fill #2563eb, accent #b4c5ff.
export const TERMINAL_SEARCH_DECORATIONS: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#2563eb',
  matchBorder: '#b4c5ff',
  matchOverviewRuler: '#b4c5ff',
  activeMatchBackground: '#b4c5ff',
  activeMatchBorder: '#ffffff',
  activeMatchColorOverviewRuler: '#ffffff',
};

// satisfies ISearchOptions 锁 return type；若 satisfies typecheck 红
// → 修包侧 SearchDecorations/TerminalSearchAddonOptions 字段名/可选性匹配 ISearchOptions
// 禁用 `as ISearchOptions` 兜底（plan-v4 P1-3 决议）
export function toSearchAddonOptions(options: TerminalSearchOptions): ISearchOptions {
  return packageToOpts(options, TERMINAL_SEARCH_DECORATIONS) satisfies ISearchOptions;
}

// 本地 3 参 API，内部注入 DECORATIONS；与包同名 4 参版本通过 `as packageApply` 别名隔离
export function applyTerminalSearchEffect(
  addon: SearchAddonLike | null,
  state: TerminalSearchState,
  action: TerminalSearchAction,
): void {
  packageApply(addon, state, action, TERMINAL_SEARCH_DECORATIONS);
}

// dockview-specific active-panel resolver 留本地
export interface ActivePanelLike {
  readonly id: string;
  readonly view: { readonly contentComponent?: string };
}

export function getActiveTerminalPanelId(api: {
  readonly activePanel?: ActivePanelLike | null;
}): string | null {
  const active = api.activePanel;
  if (!active || active.view.contentComponent !== TERMINAL_PANEL_TYPE) return null;
  return active.id;
}
