// Markdown 编辑 / 预览模式(Milkdown / ProseMirror)的查找:装饰高亮全部匹配、当前匹配单独强调、选区与滚动跟随。
// 对齐 VSCode 编辑器查找控件;实现参照 prosemirror-search(按文本块取纯文本匹配 → 行内装饰),不引新依赖,只做查找。
// BDD: src/__tests__/markdown-find/
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node as PmNode } from '@milkdown/kit/prose/model';
import { regexSyntaxError } from '@/lib/search-query';
import { FIND_MATCH_LIMIT } from './find-widget-model';

export interface MarkdownFindQuery {
  readonly term: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

/** 收集匹配的上限(同代码编辑器 / 终端查找):到此即停,计数显示「1000+」。 */
export const MARKDOWN_FIND_LIMIT = FIND_MATCH_LIMIT;

/** 转义正则元字符(字面量查找;正则模式下带入选区文字)。 */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 查询 → 全局正则;空查询 / 非法正则 → null。字面量转义;全字匹配 = 前后不是 Unicode 字母 / 数字 / 下划线。
 * 带 `u` 编译(\p 需要);用户正则在 `u` 下非法(如 `\-`)时退回不带 `u`,全字边界退化为 ASCII \w。
 * 用户正则本身(不带 flag)非法即 null —— 与查找条的「正则表达式无效」提示同一判据(全字包裹不能把 `a)|(b` 这类凑成合法)。
 */
export function buildFindRegExp(query: MarkdownFindQuery): RegExp | null {
  if (!query.term) return null;
  if (query.regex && regexSyntaxError(query.term) !== null) return null;
  const body = query.regex ? query.term : escapeRegExp(query.term);
  const flags = query.caseSensitive ? 'g' : 'gi';
  try {
    return new RegExp(query.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body, `${flags}u`);
  } catch {
    try {
      return new RegExp(query.wholeWord ? `(?<!\\w)(?:${body})(?!\\w)` : body, flags);
    } catch {
      return null;
    }
  }
}

/** 文本内的非空匹配 [start, end)(最多 limit 个)。 */
export function findTextMatches(text: string, re: RegExp, limit: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (out.length < limit && (m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1; // 空匹配跳过,防死循环
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

interface FindRange {
  readonly from: number;
  readonly to: number;
}

/**
 * 文档内的匹配:逐个文本块取纯文本(行内叶子节点如图片 / 换行记一个占位符,下标与文档位置一一对应)匹配,可跨行内格式,
 * 不跨块。代码块(spec.code,CodeMirror 渲染且有自己的查找)不参与。
 */
function findDocMatches(doc: PmNode, re: RegExp): { matches: FindRange[]; capped: boolean } {
  const matches: FindRange[] = [];
  doc.descendants((node, pos) => {
    if (matches.length >= MARKDOWN_FIND_LIMIT) return false;
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    const text = node.textBetween(0, node.content.size, undefined, '￼');
    for (const [s, e] of findTextMatches(text, re, MARKDOWN_FIND_LIMIT - matches.length)) {
      matches.push({ from: pos + 1 + s, to: pos + 1 + e });
    }
    return false;
  });
  return { matches, capped: matches.length >= MARKDOWN_FIND_LIMIT };
}

interface FindState {
  readonly query: MarkdownFindQuery | null;
  readonly matches: readonly FindRange[];
  /** 当前匹配下标;-1 = 无。 */
  readonly current: number;
  readonly decorations: DecorationSet;
}

type FindMeta = { readonly query: MarkdownFindQuery | null } | { readonly step: 1 | -1 };

const findKey = new PluginKey<FindState>('continuo-markdown-find');

const EMPTY: FindState = { query: null, matches: [], current: -1, decorations: DecorationSet.empty };

/** 选区起(dir=1:选区之后第一个;dir=-1:选区之前最后一个),找不到则循环到另一端。 */
function nearIndex(matches: readonly FindRange[], from: number, to: number, dir: 1 | -1): number {
  if (matches.length === 0) return -1;
  if (dir === 1) {
    const i = matches.findIndex((m) => m.from >= from);
    return i >= 0 ? i : 0;
  }
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i]!.to <= to) return i;
  return matches.length - 1;
}

function withDecorations(doc: PmNode, query: MarkdownFindQuery | null, matches: readonly FindRange[], current: number): FindState {
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, { class: i === current ? 'co-find-match co-find-match-current' : 'co-find-match' }),
  );
  return { query, matches, current, decorations: DecorationSet.create(doc, decos) };
}

function applyFind(tr: Transaction, prev: FindState, state: EditorState): FindState {
  const meta = tr.getMeta(findKey) as FindMeta | undefined;
  const { from, to } = state.selection;
  if (meta && 'query' in meta) {
    const re = meta.query ? buildFindRegExp(meta.query) : null;
    if (!meta.query) return EMPTY;
    const { matches } = re ? findDocMatches(state.doc, re) : { matches: [] };
    return withDecorations(state.doc, meta.query, matches, nearIndex(matches, from, to, 1));
  }
  if (meta && 'step' in meta) {
    const n = prev.matches.length;
    if (n === 0) return prev;
    const cur = prev.matches[prev.current];
    // 选区仍在当前匹配上 → 顺次;用户点过正文(选区移开)→ 从选区起找
    const next =
      cur && cur.from === from && cur.to === to
        ? (prev.current + meta.step + n) % n
        : meta.step === 1
          ? nearIndex(prev.matches, to, to, 1)
          : nearIndex(prev.matches, from, from, -1);
    return withDecorations(state.doc, prev.query, prev.matches, next);
  }
  if (tr.docChanged && prev.query) {
    const re = buildFindRegExp(prev.query);
    const { matches } = re ? findDocMatches(state.doc, re) : { matches: [] };
    const cur = prev.matches[prev.current];
    const anchor = cur ? tr.mapping.map(cur.from) : from;
    return withDecorations(state.doc, prev.query, matches, nearIndex(matches, anchor, anchor, 1));
  }
  return prev;
}

// 各视图的查找结果变化回调(查找条计数;含查找条打开时编辑文档后的重算)。
const changeListeners = new WeakMap<EditorView, (result: MarkdownFindResult) => void>();

/** 订阅视图的查找结果变化(每视图一个订阅者);返回退订。 */
export function onMarkdownFindChange(view: EditorView, cb: (result: MarkdownFindResult) => void): () => void {
  changeListeners.set(view, cb);
  return () => {
    if (changeListeners.get(view) === cb) changeListeners.delete(view);
  };
}

/** 查找插件(经 Milkdown $prose 注册;插件对象无实例状态,可被多个编辑器共用)。 */
export const markdownFindPlugin = new Plugin<FindState>({
  key: findKey,
  state: { init: () => EMPTY, apply: applyFind },
  props: { decorations: (state) => findKey.getState(state)?.decorations },
  view: () => ({
    update: (view, prevState) => {
      if (findKey.getState(view.state) !== findKey.getState(prevState)) changeListeners.get(view)?.(markdownFindResult(view.state));
    },
  }),
});

export interface MarkdownFindResult {
  /** 匹配数(封顶 MARKDOWN_FIND_LIMIT)。 */
  readonly count: number;
  /** 当前匹配下标(0 起);-1 = 无。 */
  readonly index: number;
}

export function markdownFindResult(state: EditorState): MarkdownFindResult {
  const s = findKey.getState(state) ?? EMPTY;
  return { count: s.matches.length, index: s.current };
}

/** 当前匹配设为选区(不进撤销历史);滚动另由 revealMarkdownFindMatch 做(焦点在查找条时 ProseMirror 不滚选区)。 */
function selectCurrent(view: EditorView): void {
  const s = findKey.getState(view.state);
  const m = s?.matches[s.current];
  if (!m) return;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to)).setMeta('addToHistory', false));
}

/**
 * 设置 / 清除(null)查询:重算匹配,当前匹配 = 选区之后第一个,并选中。select=false 只高亮不动选区(切回 tab 恢复查找状态、
 * 查找条关闭后 F3 / ⌘G 先恢复查询再从选区起跳)。
 */
export function setMarkdownFindQuery(
  view: EditorView,
  query: MarkdownFindQuery | null,
  { select = true }: { readonly select?: boolean } = {},
): MarkdownFindResult {
  view.dispatch(view.state.tr.setMeta(findKey, { query } satisfies FindMeta).setMeta('addToHistory', false));
  if (query && select) selectCurrent(view);
  return markdownFindResult(view.state);
}

/** 下一个(1)/ 上一个(-1)匹配,循环,并选中。 */
export function stepMarkdownFind(view: EditorView, step: 1 | -1): MarkdownFindResult {
  view.dispatch(view.state.tr.setMeta(findKey, { step } satisfies FindMeta).setMeta('addToHistory', false));
  selectCurrent(view);
  return markdownFindResult(view.state);
}

/** 位置在滚动容器视口外 → 滚到视口中央(VSCode revealRangeInCenterIfOutsideViewport)。 */
function revealPosInCenterIfOutside(view: EditorView, pos: number, scroller: HTMLElement): void {
  let rect: { top: number; bottom: number };
  try {
    rect = view.coordsAtPos(pos);
  } catch {
    return; // 无布局(未挂载 / 测试环境)
  }
  const box = scroller.getBoundingClientRect();
  if (rect.top >= box.top && rect.bottom <= box.bottom) return;
  scroller.scrollTop += rect.top - (box.top + box.height / 2);
}

/** 当前匹配在滚动容器视口外 → 滚到视口中央。 */
export function revealMarkdownFindMatch(view: EditorView, scroller: HTMLElement): void {
  const s = findKey.getState(view.state);
  const m = s?.matches[s.current];
  if (m) revealPosInCenterIfOutside(view, m.from, scroller);
}

/** 选中 [from, to)(不进撤销历史),在视口外则滚到视口中央(打开在文件中查找的结果;VSCode 打开带选区的编辑器同)。 */
export function selectAndRevealMarkdownRange(view: EditorView, scroller: HTMLElement, from: number, to: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)).setMeta('addToHistory', false));
  revealPosInCenterIfOutside(view, from, scroller);
}

/** 一个 tab 的查找条状态(切 tab / 切 编辑·预览 重挂后恢复:查找条、查找词、选项与高亮)。 */
export interface MarkdownFindSession {
  readonly open: boolean;
  readonly term: string;
  readonly options: Omit<MarkdownFindQuery, 'term'>;
}

/** 最多保留的 tab 数(同编辑器视图状态缓存 50;最久未用先淘汰)。 */
const FIND_SESSION_LIMIT = 50;
const findSessions = new Map<string, MarkdownFindSession>();

export function saveMarkdownFindSession(tabId: string, session: MarkdownFindSession): void {
  findSessions.delete(tabId);
  findSessions.set(tabId, session);
  if (findSessions.size > FIND_SESSION_LIMIT) {
    const oldest = findSessions.keys().next().value;
    if (oldest !== undefined) findSessions.delete(oldest);
  }
}

export function markdownFindSessionOf(tabId: string): MarkdownFindSession | undefined {
  return findSessions.get(tabId);
}

/** tab 关闭后丢弃(重新打开不恢复)。 */
export function forgetMarkdownFindSession(tabId: string): void {
  findSessions.delete(tabId);
}

/** 测试用:清空。 */
export function clearMarkdownFindSessions(): void {
  findSessions.clear();
}
