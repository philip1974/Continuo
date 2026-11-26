// CodeMirror ⌘F 查找面板的补强(对齐 VSCode 查找控件 findWidget):匹配计数「当前 / 总数」与「无结果」(标红 + 读屏播报)、
// 替换快捷键(⌥⌘F / Ctrl+H)、选项切换(⌥⌘C / ⌥⌘W / ⌥⌘R,Windows / Linux 为 Alt+C / W / R;与在文件中查找 / 终端查找同一组,
// 见 src/lib/find-options)、查找框 ↑ / ↓ 历史、选项 / 按钮 tooltip(名称 + 快捷键)。
//
// 不自建面板(search({ createPanel })):@codemirror/search 不导出默认 SearchPanel,自建等于整段重写替换 / 只读 / 键盘
// scope / phrases 逻辑。这里保留默认面板,ViewPlugin 在面板上追加一个计数元素并挂查找框按键 —— 面板结构只依赖
// CodeMirror 自己也用的 `.cm-search` / `[main-field]` / `input[name=replace]`。选项复选框由默认面板随 setSearchQuery 自动同步。
// CodeEditor(代码文件 + Markdown 源码)与 Markdown 代码块(经 markdownCodeBlockTheme)共用。
// BDD: src/__tests__/editor-find-widget/

import { Prec, type EditorState, type Extension } from '@codemirror/state';
import { ViewPlugin, keymap, type Command, type EditorView, type ViewUpdate } from '@codemirror/view';
import { SearchQuery, getSearchQuery, openSearchPanel, search, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { isImeComposing } from '@/design/ime';
import { regexSyntaxError } from '@/lib/search-query';
import { findOptionTooltip, type FindOption } from '@/lib/find-options';
import { hotkeyText, withHotkey } from '@/lib/hotkey-label';
import { editorFindHistory, FIND_MATCH_LIMIT, formatFindCount, type FindCountState } from './find-widget-model';

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

/** 已数到的匹配(扁平 [from, to, ...])与是否封顶;非法 / 空查询为空。 */
function collectMatches(state: EditorState, q: SearchQuery): { ranges: number[]; capped: boolean } {
  const ranges: number[] = [];
  if (!q.valid) return { ranges, capped: false };
  const cursor = q.getCursor(state);
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    if (ranges.length >= FIND_MATCH_LIMIT * 2) return { ranges, capped: true };
    ranges.push(r.value.from, r.value.to);
  }
  return { ranges, capped: false };
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

class FindWidget {
  private panel: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private count: HTMLElement | null = null;
  private query: SearchQuery | null = null;
  private ranges: number[] = [];
  private capped = false;

  constructor(private readonly view: EditorView) {
    this.sync(true);
  }

  update(update: ViewUpdate): void {
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
    if (docChanged || !this.query || !q.eq(this.query)) {
      this.query = q;
      ({ ranges: this.ranges, capped: this.capped } = collectMatches(state, q));
    }
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
    };
    const text = formatFindCount(count);
    // 文案不变不写 DOM:role=status 只在变化时播报
    if (this.count && this.count.textContent !== text) this.count.textContent = text;
    const noResults = !count.empty && count.total === 0;
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
    this.input?.addEventListener('keydown', this.onKeyDown);
    this.input?.addEventListener('input', this.onInput);
    editorFindHistory.resetCursor();
  }

  private detach(): void {
    if (!this.panel) return;
    // 关闭面板时查找框里的词也进历史(VSCode 同)
    if (this.input) editorFindHistory.add(this.input.value);
    this.input?.removeEventListener('keydown', this.onKeyDown);
    this.input?.removeEventListener('input', this.onInput);
    this.count?.remove();
    this.panel = this.input = this.count = null;
  }

  private readonly onInput = (): void => editorFindHistory.resetCursor();

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isImeComposing(event) || event.altKey || event.ctrlKey || event.metaKey) return;
    const input = this.input;
    if (!input) return;
    if (event.key === 'Enter') {
      editorFindHistory.add(input.value);
      return;
    }
    if (event.shiftKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const term = event.key === 'ArrowUp' ? editorFindHistory.previous(input.value) : editorFindHistory.next();
    if (term === undefined) return;
    this.view.dispatch({ effects: setSearchQuery.of(withQuery(getSearchQuery(this.view.state), { search: term })) });
  };
}

/**
 * 查找面板补强扩展(一个常量:同一编辑器重复引入时 CodeMirror 去重)。
 * 计数插件 Prec.lowest:排在面板插件之后更新,打开面板的那次更新里面板 DOM 已在。
 */
export const codeMirrorFind: Extension = [
  search(),
  keymap.of([
    // VSCode:mac ⌥⌘F,Windows / Linux Ctrl+H
    { key: 'Ctrl-h', mac: 'Mod-Alt-f', run: openReplacePanel, scope: 'editor search-panel', preventDefault: true },
    { key: 'Alt-c', mac: 'Mod-Alt-c', run: toggleSearchOption('caseSensitive'), scope: 'editor search-panel' },
    { key: 'Alt-w', mac: 'Mod-Alt-w', run: toggleSearchOption('wholeWord'), scope: 'editor search-panel' },
    { key: 'Alt-r', mac: 'Mod-Alt-r', run: toggleSearchOption('regexp'), scope: 'editor search-panel' },
  ]),
  Prec.lowest(ViewPlugin.fromClass(FindWidget)),
];
