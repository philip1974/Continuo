// Continuo-local thin wrapper for @continuo-terminal/react-terminal search-state.
// Re-exports package types/reducer/effect with explicit named exports (not `export *`)
// to avoid leaking the package's 4-arg applyTerminalSearchEffect into Continuo call sites.
// host-specific bindings (decoration colors read from theme tokens) stay here.
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
import { readThemeTokens } from '@/theme/read-theme-tokens';

type SearchDecorations = NonNullable<ISearchOptions['decorations']>;

// 搜索装饰色 ← 主题 token(light / dark 各有值)。xterm 只收 #RRGGBB 字面色,故运行时读计算值。
const DECORATION_TOKENS: Readonly<Record<keyof SearchDecorations & string, string>> = {
  matchBackground: '--md-primary-container',
  matchBorder: '--md-primary',
  matchOverviewRuler: '--md-primary',
  activeMatchBackground: '--md-primary',
  activeMatchBorder: '--md-on-primary-container',
  activeMatchColorOverviewRuler: '--md-on-primary-container',
};

/** token 读不到或不是 #RRGGBB 时的兜底(暗色色板取值)。 */
export const FALLBACK_TERMINAL_SEARCH_DECORATIONS: SearchDecorations = {
  matchBackground: '#2563eb',
  matchBorder: '#b4c5ff',
  matchOverviewRuler: '#b4c5ff',
  activeMatchBackground: '#b4c5ff',
  activeMatchBorder: '#eeefff',
  activeMatchColorOverviewRuler: '#eeefff',
};

const HEX_RRGGBB = /^#[0-9a-f]{6}$/i;
// 缓存按取色时的主题(<html> 是否带 .dark)做键:主题切换时即使没有任何终端挂载(无人调 invalidate),下一次
// 取色也会因键不符而重读 token,不沿用旧主题色板。
let cachedDecorations: { readonly dark: boolean; readonly values: SearchDecorations } | null = null;

function currentThemeIsDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

/**
 * 当前主题下的搜索装饰色。读 token 并按主题缓存(读不到不缓存,下次重试)。
 * 惰性读取而非在主题 effect 里读:子组件 effect 先于 ThemeProvider 切 <html class> 执行。
 */
export function getTerminalSearchDecorations(): SearchDecorations {
  const dark = currentThemeIsDark();
  if (cachedDecorations && cachedDecorations.dark === dark) return cachedDecorations.values;
  const values = readThemeTokens(DECORATION_TOKENS);
  if (values === null || !Object.values(values).every((v) => HEX_RRGGBB.test(v))) {
    return FALLBACK_TERMINAL_SEARCH_DECORATIONS;
  }
  cachedDecorations = { dark, values };
  return values;
}

export function invalidateTerminalSearchDecorations(): void {
  cachedDecorations = null;
}

// satisfies ISearchOptions 锁 return type；若 satisfies typecheck 红
// → 修包侧 SearchDecorations/TerminalSearchAddonOptions 字段名/可选性匹配 ISearchOptions
// 禁用 `as ISearchOptions` 兜底（plan-v4 P1-3 决议）
export function toSearchAddonOptions(options: TerminalSearchOptions): ISearchOptions {
  return packageToOpts(options, getTerminalSearchDecorations()) satisfies ISearchOptions;
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

// 本地 API(addon, state, action, term?)：内部注入当前主题的装饰色(包版第 4 参是 decorations,本地第 4 参是可选的 term,
// 用于清 selection)；与包同名版本通过 `as packageApply` 别名隔离
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
  packageApply(addon, state, action, getTerminalSearchDecorations());
  return true;
}
