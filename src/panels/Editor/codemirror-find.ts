// CodeMirror ⌘F 查找面板的补强(对齐 VSCode 查找控件 findWidget):匹配计数「当前 / 总数」与「无结果」(标红 + 读屏播报)、
// 替换快捷键(⌥⌘F / Ctrl+H;只在 Markdown 代码块的键表里,CodeEditor 经命令注册表)、选项切换(⌥⌘C / ⌥⌘W / ⌥⌘R,Windows / Linux 为 Alt+C / W / R;与在文件中查找 / 终端查找同一组,
// 见 src/lib/find-options)、查找框 ↑ / ↓ 历史、选项 / 按钮 tooltip(名称 + 快捷键)。
//
// 不自建面板(search({ createPanel })):@codemirror/search 不导出默认 SearchPanel,自建等于整段重写替换 / 只读 / 键盘
// scope / phrases 逻辑。这里保留默认面板,ViewPlugin 在面板上追加一个计数元素并挂查找框按键 —— 面板结构只依赖
// CodeMirror 自己也用的 `.cm-search` / `[main-field]` / `input[name=replace]`。选项复选框由默认面板随 setSearchQuery 自动同步;
// 复选框按共享顺序(Aa / ab / .*)移进查找框后的选项组,外观改为与终端 / 在文件中查找同款的 toggle(arrangeOptionToggles)。
// CodeEditor(代码文件 + Markdown 源码)与 Markdown 代码块(经 markdownCodeBlockTheme)共用。
// BDD: src/__tests__/editor-find-widget/
//
// Ported from codemirror/search (MIT, © Marijn Haverbeke and others; see LICENSE-3RD-PARTY.md):announceMatch 与
// replacementFor(unquote + getReplacement)两段照抄自 @codemirror/search src/search.ts(其未导出)。

import { EditorSelection, Prec, type ChangeDesc, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type Command, type ViewUpdate } from '@codemirror/view';
import {
  SearchQuery,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceNext,
  search,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search';
import { isImeComposing } from '@/design/ime';
import { regexSyntaxError } from '@/lib/search-query';
import { t } from '@/i18n';
import { FIND_OPTION_GLYPHS, FIND_OPTIONS, FIND_OPTIONS_GROUP_KEY, findOptionTooltip, type FindOption } from '@/lib/find-options';
import { hotkeyText, withHotkey } from '@/lib/hotkey-label';
import { editorFindHistory, formatFindCount, type FindCountState } from './find-widget-model';
import { MatchScan } from './find-match-scan';

type ToggleField = 'caseSensitive' | 'wholeWord' | 'regexp';

function withQuery(q: SearchQuery, patch: Partial<Pick<SearchQuery, 'search' | ToggleField>>): SearchQuery {
  return new SearchQuery({
    search: q.search,
    caseSensitive: q.caseSensitive,
    literal: q.literal,
    regexp: q.regexp,
    wholeWord: q.wholeWord,
    replace: q.replace,
    test: q.test,
    ...patch,
  });
}

/** 翻转查找选项(复选框随默认面板的 setSearchQuery 同步)。面板未打开时不处理,按键照常传给别处。 */
export function toggleSearchOption(field: ToggleField): Command {
  return (view) => {
    if (!searchPanelOpen(view.state)) return false;
    const q = getSearchQuery(view.state);
    view.dispatch({ effects: setSearchQuery.of(withQuery(q, { [field]: !q[field] })) });
    return true;
  };
}

/**
 * 打开查找面板,聚焦并全选查找框(VSCode「查找」;菜单 / 命令面板执行时焦点也落到查找框)。焦点已在查找框时再按也全选
 *(VSCode 同;CodeMirror 的 openSearchPanel 此时不做任何事)。
 */
export const openFindPanel: Command = (view) => {
  openSearchPanel(view);
  const input = view.dom.querySelector<HTMLInputElement>('.cm-search [main-field]');
  if (input) {
    input.focus();
    input.select();
  }
  return true;
};

/** 打开查找面板并聚焦替换框(VSCode「替换」);只读文档无替换框,停在查找框。 */
export const openReplacePanel: Command = (view) => {
  openSearchPanel(view);
  const replace = view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]');
  if (replace) {
    replace.focus();
    replace.select();
  }
  return true;
};

/** 文档变化后把已数到的匹配映射到新位置(VSCode 的查找装饰随编辑移动);被删掉 / 改成空的匹配丢弃。 */
function mapRanges(ranges: readonly number[], changes: ChangeDesc): number[] {
  const out: number[] = [];
  for (let i = 0; i < ranges.length; i += 2) {
    const from = changes.mapPos(ranges[i]!, 1);
    const to = changes.mapPos(ranges[i + 1]!, -1);
    if (to > from || (to === from && ranges[i] === ranges[i + 1])) out.push(from, to);
  }
  return out;
}

/** 第一个起点 >= pos 的匹配下标(匹配数 = 未找到)。 */
function lowerBound(ranges: readonly number[], pos: number): number {
  let lo = 0;
  let hi = ranges.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid * 2]! < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const ANNOUNCE_MARGIN = 30;
const ANNOUNCE_BREAK = /[\s.,:;?!]/;

/** 读屏播报当前匹配(照抄 @codemirror/search src/search.ts 的 announceMatch,MIT,其未导出):「当前匹配. <上下文> 在第 N 行.」 */
function announceMatch(state: EditorState, { from, to }: { from: number; to: number }) {
  const line = state.doc.lineAt(from);
  const lineEnd = state.doc.lineAt(to).to;
  const start = Math.max(line.from, from - ANNOUNCE_MARGIN);
  const end = Math.min(lineEnd, to + ANNOUNCE_MARGIN);
  let text = state.sliceDoc(start, end);
  if (start !== line.from) {
    for (let i = 0; i < ANNOUNCE_MARGIN; i++)
      if (!ANNOUNCE_BREAK.test(text[i + 1] ?? '') && ANNOUNCE_BREAK.test(text[i] ?? '')) {
        text = text.slice(i);
        break;
      }
  }
  if (end !== lineEnd) {
    for (let i = text.length - 1; i > text.length - ANNOUNCE_MARGIN; i--)
      if (!ANNOUNCE_BREAK.test(text[i - 1] ?? '') && ANNOUNCE_BREAK.test(text[i] ?? '')) {
        text = text.slice(0, i);
        break;
      }
  }
  return EditorView.announce.of(
    `${state.phrase('current match')}. ${text} ${state.phrase('on line')} ${line.number}.`,
  );
}

interface Match {
  readonly from: number;
  readonly to: number;
}

const isEmptyAt = (m: Match | null, pos: number): boolean => !!m && m.from === m.to && m.from === pos;

/** 从 pos 起的第一个匹配(搜索,不用已数到的匹配)。 */
function searchFrom(state: EditorState, q: SearchQuery, pos: number): Match | null {
  const r = q.getCursor(state, pos).next();
  return r.done ? null : r.value;
}

/** 向前找的块大小(同 @codemirror/search 的 FindPrev.ChunkSize)。 */
const PREV_CHUNK = 10000;

/**
 * [from, to] 内最后一个匹配(跳过恰在 skip 处的空匹配)。同 @codemirror/search 正则查询的 prevMatchInRange:从 to 往前按块逐步
 * 扩大范围正向扫;匹配离块起点太近可能是被截断的更长匹配,继续扩大。
 */
function lastMatchIn(state: EditorState, q: SearchQuery, from: number, to: number, skip: number): Match | null {
  for (let size = 1; ; size++) {
    const start = Math.max(from, to - size * PREV_CHUNK);
    let found: Match | null = null;
    const cursor = q.getCursor(state, start, to);
    for (let r = cursor.next(); !r.done; r = cursor.next()) if (!isEmptyAt(r.value, skip)) found = r.value;
    if (found && (start === from || found.from > start + 10)) return found;
    if (start === from) return null;
  }
}

/**
 * 起点 >= pos 的第一个匹配,到尾绕回开头(VSCode model.findNextMatch)。ranges:已数到的完整匹配(二分);null → 搜索。
 */
function matchAtOrAfter(state: EditorState, q: SearchQuery, ranges: readonly number[] | null, pos: number): Match | null {
  if (!ranges) return searchFrom(state, q, pos) ?? (pos > 0 ? searchFrom(state, q, 0) : null);
  const n = ranges.length / 2;
  if (n === 0) return null;
  let i = lowerBound(ranges, pos);
  if (i === n) i = 0;
  return { from: ranges[i * 2]!, to: ranges[i * 2 + 1]! };
}

/**
 * 查找下一个(VSCode _moveToNextMatch):从 after 往后的第一个匹配;它是恰在 after 处的空匹配(正则 ^ / $ / x* / \b)时
 * 从下一位置再找,否则回车永远停在原地。
 */
function nextMatchAfter(state: EditorState, q: SearchQuery, ranges: readonly number[] | null, after: number): Match | null {
  const m = matchAtOrAfter(state, q, ranges, after);
  if (!isEmptyAt(m, after)) return m;
  return matchAtOrAfter(state, q, ranges, after < state.doc.length ? after + 1 : 0);
}

/** 查找上一个(VSCode _moveToPrevMatch):终点 <= before 的最后一个匹配,跳过恰在 before 处的空匹配;没有则绕到末尾。 */
function prevMatchBefore(state: EditorState, q: SearchQuery, ranges: readonly number[] | null, before: number): Match | null {
  if (!ranges) return lastMatchIn(state, q, 0, before, before) ?? lastMatchIn(state, q, before, state.doc.length, before);
  const n = ranges.length / 2;
  if (n === 0) return null;
  let i = lowerBound(ranges, before) - 1;
  while (i >= 0 && ranges[i * 2 + 1]! > before) i--;
  if (i >= 0 && isEmptyAt({ from: ranges[i * 2]!, to: ranges[i * 2 + 1]! }, before)) i--;
  if (i < 0) i = n - 1;
  return { from: ranges[i * 2]!, to: ranges[i * 2 + 1]! };
}

/** 替换文本(照抄 @codemirror/search src/search.ts 的 unquote + 正则 getReplacement,MIT,其未导出):\n \r \t \\ 转义;正则 $& / $$ / $n 捕获组。 */
function replacementFor(state: EditorState, q: SearchQuery, m: Match): string {
  const text = q.literal
    ? q.replace
    : q.replace.replace(/\\([nrt\\])/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\'));
  if (!q.regexp) return text;
  // 已数到的匹配不带捕获组:从匹配起点重跑一次正则(只扫到这个匹配)
  const r = q.getCursor(state, m.from).next();
  const match = !r.done && r.value.from === m.from && r.value.to === m.to ? (r.value as { match?: RegExpExecArray }).match : undefined;
  if (!match) return text;
  return text.replace(/\$([$&]|\d+)/g, (whole, i: string) => {
    if (i === '&') return match[0];
    if (i === '$') return '$';
    for (let l = i.length; l > 0; l--) {
      const n = +i.slice(0, l);
      if (n > 0 && n < match.length) return (match[n] ?? '') + i.slice(l);
    }
    return whole;
  });
}

/** 选中匹配并播报 / 滚动(同 @codemirror/search 的 findNext;焦点在查找框时全选,同其 selectSearchInput)。 */
function selectMatch(view: EditorView, { from, to }: Match): void {
  const selection = EditorSelection.single(from, to);
  view.dispatch({
    selection,
    effects: [announceMatch(view.state, { from, to }), EditorView.scrollIntoView(selection.main)],
    userEvent: 'select.search',
  });
  const input = view.dom.querySelector<HTMLInputElement>('.cm-search [main-field]');
  if (input && input === view.root.activeElement) input.select();
}

/**
 * 查找下一个 / 上一个。ranges:已数到的完整匹配(null → 搜索)。文本查询不会有空匹配,未数完时沿用 @codemirror/search 自己的
 * findNext / findPrevious;正则未数完时自己搜(它的 findNext 遇空匹配停在原地)。查询无效 → 交给它(打开面板)。
 */
function stepMatch(view: EditorView, dir: 1 | -1, ranges: readonly number[] | null): boolean {
  const { state } = view;
  const q = getSearchQuery(state);
  if (!q.valid || (!ranges && !q.regexp)) return (dir === 1 ? findNext : findPrevious)(view);
  const sel = state.selection.main;
  const m = dir === 1 ? nextMatchAfter(state, q, ranges, sel.to) : prevMatchBefore(state, q, ranges, sel.from);
  if (!m) return false;
  selectMatch(view, m);
  return true;
}

/**
 * 替换(VSCode findModel.replace()):选区恰是起点 >= 选区起点的第一个匹配 → 替换它,并选中替换结尾之后的下一个匹配(替换结果
 * 仍匹配时不会停在原处);否则只选中那个匹配。一次替换一个事务(撤销一步撤回一次)。@codemirror/search 的 replaceNext 替换后
 * 选区停在替换出的文字上,每处要按两次,替换结果仍匹配时永远卡住。
 */
function replaceStep(view: EditorView, ranges: readonly number[] | null): boolean {
  const { state } = view;
  const q = getSearchQuery(state);
  if (!q.valid) return replaceNext(view);
  if (state.readOnly) return false;
  const sel = state.selection.main;
  const m = matchAtOrAfter(state, q, ranges, sel.from);
  if (!m) return false;
  if (m.from !== sel.from || m.to !== sel.to) {
    selectMatch(view, m);
    return true;
  }
  const changes = state.changes({ from: m.from, to: m.to, insert: state.toText(replacementFor(state, q, m)) });
  const after = state.update({ changes }).state;
  const end = changes.mapPos(m.to, 1);
  // 已数到的匹配随替换映射(被替换的那处丢弃);只剩它一个时搜索(替换结果可能仍匹配)
  const mapped = ranges ? mapRanges(ranges, changes) : null;
  const next = nextMatchAfter(after, q, mapped?.length ? mapped : null, end);
  const selection = next ? EditorSelection.single(next.from, next.to) : EditorSelection.single(end);
  view.dispatch({
    changes,
    selection,
    effects: [
      EditorView.announce.of(`${state.phrase('replaced match on line $', state.doc.lineAt(m.from).number)}.`),
      ...(next ? [announceMatch(after, next), EditorView.scrollIntoView(selection.main)] : []),
    ],
    userEvent: 'input.replace',
  });
  return true;
}

/** 主选区恰好是第几个匹配(1 起;不在已数到的匹配上为 0)。二分。 */
function currentIndex(ranges: readonly number[], from: number, to: number): number {
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = ranges[mid * 2]!;
    if (f < from) lo = mid + 1;
    else if (f > from) hi = mid - 1;
    else return ranges[mid * 2 + 1] === to ? mid + 1 : 0;
  }
  return 0;
}

/** 选项复选框(默认面板 input name)→ 共享选项与面板 phrase。 */
const OPTION_FIELDS: ReadonlyArray<readonly [name: string, option: FindOption, phrase: string]> = [
  ['case', 'caseSensitive', 'match case'],
  ['word', 'wholeWord', 'by word'],
  ['re', 'regex', 'regexp'],
];
const OPTION_INPUT_NAME: Readonly<Record<FindOption, string>> = { caseSensitive: 'case', wholeWord: 'word', regex: 're' };
/** 按钮(默认面板 button name)→ 面板 phrase 与面板内按键(VSCode 查找控件 tooltip「下一个匹配项 (Enter)」)。 */
const BUTTON_TITLES: ReadonlyArray<readonly [name: string, phrase: string, combo?: string]> = [
  ['next', 'next', 'enter'],
  ['prev', 'previous', 'shift+enter'],
  ['select', 'all'],
  ['replace', 'replace'],
  ['replaceAll', 'replace all'],
  ['close', 'close', 'escape'],
];

/** 默认面板控件补 tooltip(VSCode:选项 / 按钮悬停显示名称与快捷键)。默认面板的复选框 / 按钮本身无 title。 */
function addPanelTitles(view: EditorView, panel: HTMLElement): void {
  for (const [name, option, phrase] of OPTION_FIELDS) {
    const label = panel.querySelector(`input[name="${name}"]`)?.closest('label');
    label?.setAttribute('title', findOptionTooltip(view.state.phrase(phrase), option));
  }
  for (const [name, phrase, combo] of BUTTON_TITLES) {
    const label = view.state.phrase(phrase);
    panel.querySelector(`button[name="${name}"]`)?.setAttribute('title', withHotkey(label, combo && hotkeyText(combo)));
  }
}

/**
 * 选项复选框 → toggle(VSCode findInput 与终端 / 在文件中查找的 Aa / ab / .*):按共享顺序(默认面板是 case / regexp / by word)
 * 移进紧跟 after 的 role=group「搜索选项」;label 内补 aria-hidden 字形,原文字包成视觉隐藏(可访问名仍是选项名)。
 * 仍是原生复选框:勾选态由默认面板随 setSearchQuery 同步,点击 / 空格照常翻转查找状态,无需另写同步。外观见 code-editor-theme。
 */
function arrangeOptionToggles(panel: HTMLElement, after: Element): void {
  const doc = panel.ownerDocument;
  const group = doc.createElement('span');
  group.className = 'cm-search-options';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', t(FIND_OPTIONS_GROUP_KEY));
  for (const option of FIND_OPTIONS) {
    const input = panel.querySelector(`input[name="${OPTION_INPUT_NAME[option]}"]`);
    const label = input?.closest('label');
    if (!input || !label) continue;
    label.classList.add('cm-search-option');
    for (const node of [...label.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const name = doc.createElement('span');
      name.className = 'cm-search-option-name';
      node.replaceWith(name);
      name.append(node);
    }
    const glyph = doc.createElement('span');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = FIND_OPTION_GLYPHS[option];
    input.after(glyph);
    group.append(label);
  }
  after.after(group);
}

/** 按键路径上同步扫描的时间上限(ms);扫不完的放到后续分片(每片同样上限),期间计数显示「N+」/「…」。 */
const SCAN_SLICE_MS = 8;
/** 大文档编辑后重数的延迟(VSCode findModel `_updateDecorationsScheduler` 同为 100ms);期间沿用随编辑映射的旧匹配。 */
const DOC_CHANGE_RESCAN_DELAY_MS = 100;

class FindWidget {
  private panel: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private count: HTMLElement | null = null;
  private query: SearchQuery | null = null;
  private ranges: number[] = [];
  private capped = false;
  /** ranges 是当前查询在当前文档上的完整结果(查找下一个 / 上一个可直接用,VSCode 同:匹配数在上限内时用装饰跳转)。 */
  private complete = false;
  /** 计数还在进行(查询刚变,ranges 是已扫到的部分):计数显示「N+」/「…」,不标红。 */
  private pending = false;
  /** 上次全文扫描一个分片没扫完:之后的文档变化走防抖重数,不在按键里同步试扫。 */
  private large = false;
  private scan: MatchScan | null = null;
  private sliceTimer: ReturnType<typeof setTimeout> | undefined;
  private rescanTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly view: EditorView) {
    this.sync(true);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged && this.ranges.length) this.ranges = mapRanges(this.ranges, update.changes);
    this.sync(update.docChanged);
  }

  destroy(): void {
    this.detach();
  }

  private sync(docChanged: boolean): void {
    const { state } = this.view;
    const panel = searchPanelOpen(state) ? this.view.dom.querySelector<HTMLElement>('.cm-panel.cm-search') : null;
    if (panel !== this.panel) {
      this.detach();
      if (panel) this.attach(panel);
    }
    if (!this.panel) return;
    const q = getSearchQuery(state);
    if (!this.query || !q.eq(this.query)) {
      this.query = q;
      this.recount(true);
    } else if (docChanged) {
      this.complete = false;
      this.cancelScan();
      // 小文档照旧当场重数;大文档(上次一个分片扫不完)防抖,期间显示映射后的旧匹配
      if (this.large) {
        this.rescanTimer = setTimeout(() => {
          this.rescanTimer = undefined;
          this.recount(false);
          this.render();
        }, DOC_CHANGE_RESCAN_DELAY_MS);
      }
      else this.recount(false);
    }
    this.render();
  }

  private cancelScan(): void {
    clearTimeout(this.sliceTimer);
    clearTimeout(this.rescanTimer);
    this.sliceTimer = this.rescanTimer = undefined;
    this.scan = null;
  }

  /**
   * 从头数当前查询:先在当前调用里扫一个分片(小文档就此扫完,行为与同步计数相同),扫不完的分片排到后续宏任务。
   * showPartial:查询变了 → 期间显示已扫到的部分(「N+」/「…」);文档变了 → 期间保留映射后的旧匹配,扫完再换。
   */
  private recount(showPartial: boolean): void {
    this.cancelScan();
    const scan = new MatchScan(this.view.state, this.query!);
    if (scan.run(performance.now() + SCAN_SLICE_MS)) {
      this.large = false;
      this.finish(scan);
      return;
    }
    this.large = true;
    this.scan = scan;
    this.complete = false;
    if (showPartial) {
      this.ranges = scan.ranges;
      this.capped = false;
      this.pending = true;
    }
    this.scheduleSlice();
  }

  private scheduleSlice(): void {
    this.sliceTimer = setTimeout(() => {
      this.sliceTimer = undefined;
      const scan = this.scan;
      if (!scan) return;
      if (!scan.run(performance.now() + SCAN_SLICE_MS)) {
        this.scheduleSlice();
        return;
      }
      this.finish(scan);
      this.render();
    }, 0);
  }

  private finish(scan: MatchScan): void {
    this.scan = null;
    this.ranges = scan.ranges;
    this.capped = scan.capped;
    this.complete = true;
    this.pending = false;
  }

  /**
   * 查找下一个 / 上一个(dir 1 / -1)用已数到的完整匹配跳转(VSCode findModel:匹配数在上限内时 moveToNextMatch 用装饰,不重新搜索);
   * 语义同 @codemirror/search 的 findNext / findPrevious(从选区往后 / 往前,到头绕回),空匹配不停在原地(见 stepMatch)。计数未完成 /
   * 封顶时搜索。面板未开 → undefined。
   */
  navigate(dir: 1 | -1): boolean | undefined {
    if (!this.panel) return undefined;
    return stepMatch(this.view, dir, this.completeRanges());
  }

  /** 替换(面板「替换」按钮、替换框回车);面板未打开 → undefined。 */
  replace(): boolean | undefined {
    if (!this.panel) return undefined;
    return replaceStep(this.view, this.completeRanges());
  }

  /** 已数到的匹配是当前查询在当前文档上的完整结果(未封顶)→ 它;否则 null(调用方搜索)。 */
  private completeRanges(): readonly number[] | null {
    if (!this.complete || this.capped || !this.query) return null;
    const q = getSearchQuery(this.view.state);
    return q.valid && q.eq(this.query) ? this.ranges : null;
  }

  private render(): void {
    if (!this.panel) return;
    const { state } = this.view;
    const q = getSearchQuery(state);
    const sel = state.selection.main;
    // 非法正则:错误信息(同 @codemirror/search 编译用的 flags `gmu`)放进查找框与计数区的 title —— 悬停可见,
    // 也是查找框的可访问描述(VSCode 查找框弹出正则错误信息)
    const error = q.regexp && q.search && !q.valid ? regexSyntaxError(q.search, 'gmu') : null;
    const count: FindCountState = {
      empty: q.search === '',
      total: this.ranges.length / 2,
      current: currentIndex(this.ranges, sel.from, sel.to),
      capped: this.capped,
      invalid: error !== null,
      pending: this.pending,
    };
    const text = formatFindCount(count);
    // 文案不变不写 DOM:role=status 只在变化时播报
    if (this.count && this.count.textContent !== text) this.count.textContent = text;
    const noResults = !count.empty && !count.pending && count.total === 0;
    this.count?.toggleAttribute('data-no-results', noResults);
    if (noResults) this.input?.setAttribute('aria-invalid', 'true');
    else this.input?.removeAttribute('aria-invalid');
    for (const el of [this.input, this.count]) {
      if (error) el?.setAttribute('title', error);
      else el?.removeAttribute('title');
    }
  }

  private attach(panel: HTMLElement): void {
    this.panel = panel;
    this.query = null;
    addPanelTitles(this.view, panel);
    this.input = panel.querySelector<HTMLInputElement>('[main-field]');
    const count = panel.ownerDocument.createElement('span');
    count.className = 'cm-search-count';
    // 计数 / 「无结果」经 live region 播报(同终端查找 TerminalSearchBar);焦点在查找框时读屏也能听到
    count.setAttribute('role', 'status');
    this.count = count;
    this.input?.after(count);
    arrangeOptionToggles(panel, count);
    panel.addEventListener('keydown', this.onPanelKeyDownCapture, true);
    panel.addEventListener('click', this.onPanelClickCapture, true);
    this.input?.addEventListener('keydown', this.onKeyDown);
    this.input?.addEventListener('input', this.onInput);
    editorFindHistory.resetCursor();
  }

  private detach(): void {
    if (!this.panel) return;
    // 关闭面板时查找框里的词也进历史(VSCode 同)
    if (this.input) editorFindHistory.add(this.input.value);
    this.panel.removeEventListener('keydown', this.onPanelKeyDownCapture, true);
    this.panel.removeEventListener('click', this.onPanelClickCapture, true);
    this.input?.removeEventListener('keydown', this.onKeyDown);
    this.input?.removeEventListener('input', this.onInput);
    this.count?.remove();
    this.panel = this.input = this.count = null;
    this.cancelScan();
    this.query = null;
    this.ranges = [];
    this.complete = this.pending = this.capped = false;
  }

  private readonly onInput = (): void => editorFindHistory.resetCursor();

  /**
   * 组字中(拼音 / 日文 / 韩文输入法)的按键止于面板(捕获阶段,查找框与替换框都在面板内):Esc 是取消组字、Enter 是确认候选、
   * 方向键是选候选,不能冒泡到默认面板的 keydown(runScopeHandlers 命中 Escape → closeSearchPanel 关掉整个查找条、
   * Enter → 查找下一个)或全局热键。不 preventDefault,输入法照常处理。VSCode 查找框同样不把组字按键当面板键。
   */
  private readonly onPanelKeyDownCapture = (event: KeyboardEvent): void => {
    if (isImeComposing(event)) {
      event.stopPropagation();
      return;
    }
    // 替换框回车 = 替换(默认面板的 keydown 调 replaceNext,同按钮);带 ⌥ / ⌃ / ⌘ 的照旧交给默认面板
    const target = event.target as Element | null;
    if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey || target?.getAttribute?.('name') !== 'replace') return;
    if (target.tagName !== 'INPUT') return;
    event.preventDefault();
    event.stopPropagation();
    this.replace();
  };

  /** 面板「下一个 / 上一个 / 替换」按钮:同查找框 / 替换框回车(捕获阶段截住按钮自己的 onclick)。 */
  private readonly onPanelClickCapture = (event: MouseEvent): void => {
    const name = (event.target as Element | null)?.closest?.('button')?.getAttribute('name');
    if (name !== 'next' && name !== 'prev' && name !== 'replace') return;
    event.stopPropagation();
    if (name === 'replace') this.replace();
    else this.navigate(name === 'next' ? 1 : -1);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isImeComposing(event) || event.altKey || event.ctrlKey || event.metaKey) return;
    const input = this.input;
    if (!input) return;
    if (event.key === 'Enter') {
      editorFindHistory.add(input.value);
      // 计数已完整:用已数到的匹配跳转,不再让默认面板的 findNext 重新整篇搜索(罕见词在大文档上一次 ~0.5s);空匹配前进见 stepMatch
      event.preventDefault();
      event.stopPropagation();
      this.navigate(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.shiftKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const term = event.key === 'ArrowUp' ? editorFindHistory.previous(input.value) : editorFindHistory.next();
    if (term === undefined) return;
    this.view.dispatch({ effects: setSearchQuery.of(withQuery(getSearchQuery(this.view.state), { search: term })) });
  };
}

const findWidgetPlugin = ViewPlugin.fromClass(FindWidget);

/**
 * 查找下一个 / 上一个(⌘G / ⇧⌘G、F3 等经命令注册表的入口):查找面板开着且计数已完整时用已数到的匹配跳转(VSCode 匹配数在上限内
 * 时用装饰跳转),否则搜索(见 stepMatch)。
 */
export const findNextMatch: Command = (view) => view.plugin(findWidgetPlugin)?.navigate(1) ?? stepMatch(view, 1, null);
export const findPreviousMatch: Command = (view) => view.plugin(findWidgetPlugin)?.navigate(-1) ?? stepMatch(view, -1, null);

/**
 * 查找面板补强(面板计数等 + 选项切换键)。计数插件 Prec.lowest:排在面板插件之后更新,打开面板的那次更新里面板 DOM 已在。
 */
const findWidgetCore: Extension = [
  search(),
  keymap.of([
    { key: 'Alt-c', mac: 'Mod-Alt-c', run: toggleSearchOption('caseSensitive'), scope: 'editor search-panel' },
    { key: 'Alt-w', mac: 'Mod-Alt-w', run: toggleSearchOption('wholeWord'), scope: 'editor search-panel' },
    { key: 'Alt-r', mac: 'Mod-Alt-r', run: toggleSearchOption('regexp'), scope: 'editor search-panel' },
  ]),
  Prec.lowest(findWidgetPlugin),
];

/**
 * CodeEditor 用:替换键不在键表里 —— 查找 / 替换 / 查找下一个·上一个经命令注册表分发(可改键,见 editor-text-commands;
 * BDD: src/__tests__/editor-find-keybindings/)。一个常量:同一编辑器重复引入时 CodeMirror 去重。
 */
export const codeEditorFind: Extension = findWidgetCore;

/**
 * Markdown 代码块(Crepe 的 CodeMirror,不经命令注册表)用:另带替换键(VSCode:mac ⌥⌘F,Windows / Linux Ctrl+H);
 * ⌘F / ⌘G / F3 由 Crepe 自带的 CodeMirror basicSetup 查找键表处理。
 */
export const codeMirrorFind: Extension = [
  findWidgetCore,
  keymap.of([{ key: 'Ctrl-h', mac: 'Mod-Alt-f', run: openReplacePanel, scope: 'editor search-panel', preventDefault: true }]),
];
