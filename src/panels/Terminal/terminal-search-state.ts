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

/** 本次 action 会以 regex 模式搜索、且搜索词不是合法正则 → true。 */
function searchesInvalidRegex(
  state: TerminalSearchState,
  action: TerminalSearchAction,
): boolean {
  let term: string;
  let options: TerminalSearchOptions;
  if (action.type === 'setTerm') {
    term = action.term;
    options = state.options;
  } else if (action.type === 'setOptions') {
    term = state.term;
    options = action.options;
  } else if (action.type === 'next' || action.type === 'prev') {
    term = state.term;
    options = state.options;
  } else {
    return false;
  }
  if (!options.regex || term.length === 0) return false;
  try {
    // 与 xterm SearchEngine 同款构造(flags 不影响语法合法性)
    new RegExp(term);
    return false;
  } catch {
    return true;
  }
}

// 本地 3 参 API，内部注入 DECORATIONS；与包同名 4 参版本通过 `as packageApply` 别名隔离
// 返回 false = 搜索词是非法正则、未交给 addon:xterm SearchEngine 内直接 RegExp(term) 无 try/catch,
// 非法正则(`[` / `(` / `\`)会抛 SyntaxError 穿透事件处理器,且 addon 记下的搜索选项会让其
// 输出触发的防抖重搜在 setTimeout 里再抛。这里预校验并清高亮(连带清 addon 缓存词),
// 调用方据此把结果置为「无匹配」。clearDecorations 不清 xterm selection(之前合法搜索 findNext
// 选中的匹配仍高亮选中)→ 传入 term 时一并 clearSelection。
export function applyTerminalSearchEffect(
  addon: SearchAddonLike | null,
  state: TerminalSearchState,
  action: TerminalSearchAction,
  term?: { clearSelection(): void } | null,
): boolean {
  if (searchesInvalidRegex(state, action)) {
    addon?.clearDecorations();
    term?.clearSelection();
    return false;
  }
  packageApply(addon, state, action, TERMINAL_SEARCH_DECORATIONS);
  return true;
}
