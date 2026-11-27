// @vitest-environment jsdom
// BDD:编辑器 ⌘F 查找面板的匹配计数 / 无结果提示、查找快捷键与历史、强制颜色下的匹配区分(对齐 VSCode 查找控件 findWidget)。
// jsdom 平台非 mac:CodeMirror 的 Mod = Ctrl,快捷键取 Windows / Linux 变体(Ctrl+H、Alt+C / W / R);mac 变体由 e2e 覆盖。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { EditorState, Text } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { getSearchQuery } from '@codemirror/search';
import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { markdownCodeBlockTheme } from '../../panels/Editor/code-editor-theme';
import { editorFindHistory } from '../../panels/Editor/find-widget-model';
import { findNextMatch, findPreviousMatch, openFindPanel } from '../../panels/Editor/codemirror-find';
import { ThemeContext } from '../../theme/ThemeProvider';
import { getLocale, notifyLocaleChange, setLocale, t, translateCount, type Locale } from '../../i18n';

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

function switchLocale(locale: Locale): void {
  act(() => {
    setLocale(locale);
    notifyLocaleChange();
  });
}

async function mount(value: string, opts: { forceLanguage?: 'markdown'; fileName?: string } = {}): Promise<EditorView> {
  const fileName = opts.fileName ?? 'find.ts';
  const utils = render(
    <ThemeContext.Provider value={{ mode: 'dark', resolved: 'dark', setMode: () => {} }}>
      <CodeEditor tabId={`/${fileName}`} value={value} fileName={fileName} forceLanguage={opts.forceLanguage} />
    </ThemeContext.Provider>,
  );
  await act(async () => {});
  const el = utils.container.querySelector<HTMLElement>('.cm-editor');
  if (!el) throw new Error('no .cm-editor');
  return EditorView.findFromDOM(el)!;
}

function key(view: EditorView, init: KeyboardEventInit, scope: 'editor' | 'search-panel' = 'editor'): boolean {
  let handled = false;
  act(() => {
    handled = runScopeHandlers(view, new KeyboardEvent('keydown', init), scope);
  });
  return handled;
}

/** 打开查找面板:CodeEditor 的 ⌘F 经命令注册表分发(actions.find → openFindPanel,见 editor-find-keybindings);Markdown 代码块的
 *  CodeMirror 仍由其 basicSetup 键表处理 Ctrl+F。 */
const openFind = (view: EditorView) =>
  view.dom.hasAttribute('data-co-text-editor')
    ? act(() => void openFindPanel(view))
    : key(view, { key: 'f', ctrlKey: true, keyCode: 70 });

function field(view: EditorView, name: 'search' | 'replace' | 'case' | 're' | 'word'): HTMLInputElement {
  const el = view.dom.querySelector<HTMLInputElement>(`.cm-search input[name="${name}"]`);
  if (!el) throw new Error(`no field ${name}`);
  return el;
}

/** 在查找框里输入(面板在 keyup 时提交查询)。 */
function typeQuery(view: EditorView, text: string): void {
  act(() => {
    const input = field(view, 'search');
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keyup', { key: text.slice(-1) || 'Backspace', bubbles: true }));
  });
}

/** 查找框里按键(冒泡到面板的 keydown 处理)。 */
function pressInSearch(view: EditorView, init: KeyboardEventInit): void {
  act(() => {
    field(view, 'search').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

const ENTER = { key: 'Enter', keyCode: 13 } as const;

function countEl(view: EditorView): HTMLElement {
  const el = view.dom.querySelector<HTMLElement>('.cm-search .cm-search-count');
  if (!el) throw new Error('no count element');
  return el;
}

/** CodeMirror 注入的全部样式文本(StyleModule 挂在 adoptedStyleSheets 或 <style>)。 */
function injectedCss(): string {
  const fromTags = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
  const adopted = (document.adoptedStyleSheets ?? []).flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join('\n');
  return `${fromTags}\n${adopted}`;
}

const FOO_154 = Array.from({ length: 154 }, (_, i) => `const foo${i} = ${i};`).join('\n') + '\n';

let original: Locale;
beforeEach(() => {
  original = getLocale();
  editorFindHistory.clear();
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  switchLocale(original);
});

describe('匹配计数与无结果提示(VSCode「1 of 154」/「No results」)', () => {
  it('输入后显示总数;跳到匹配后显示「当前 / 总数」;计数是 role=status 播报区', async () => {
    switchLocale('zh');
    const view = await mount(FOO_154);
    openFind(view);
    expect(countEl(view).getAttribute('role')).toBe('status');
    expect(countEl(view).textContent).toBe('');
    typeQuery(view, 'foo');
    expect(countEl(view).textContent).toBe(t('editor.find.match_total_other', { count: 154 }));
    pressInSearch(view, ENTER);
    expect(countEl(view).textContent).toBe(t('editor.find.match_count', { n: 1, total: '154' }));
    pressInSearch(view, ENTER);
    expect(countEl(view).textContent).toBe(t('editor.find.match_count', { n: 2, total: '154' }));
    pressInSearch(view, { ...ENTER, shiftKey: true });
    expect(countEl(view).textContent).toBe(t('editor.find.match_count', { n: 1, total: '154' }));
  });

  it('无匹配:计数区显示「无结果」(三语),查找框 aria-invalid;改回有匹配即恢复', async () => {
    for (const locale of ['zh', 'en', 'ko'] as const) {
      switchLocale(locale);
      const view = await mount(FOO_154);
      openFind(view);
      typeQuery(view, 'zzz-none');
      expect(countEl(view).textContent).toBe(t('editor.find.no_results'));
      expect(field(view, 'search').getAttribute('aria-invalid')).toBe('true');
      typeQuery(view, 'foo1');
      expect(countEl(view).textContent).not.toBe(t('editor.find.no_results'));
      expect(field(view, 'search').getAttribute('aria-invalid')).not.toBe('true');
      cleanup();
    }
    expect(new Set(['zh', 'en', 'ko'].map((l) => { setLocale(l as Locale); return t('editor.find.no_results'); })).size).toBe(3);
  });

  it('非法正则提示「正则表达式无效」(标红),title 带 RegExp 错误信息(VSCode 查找框弹出正则错误);改回合法 / 清空即恢复', async () => {
    const view = await mount(FOO_154);
    openFind(view);
    act(() => field(view, 're').click());
    typeQuery(view, 'foo(');
    expect(countEl(view).textContent).toBe(t('editor.find.invalid_regex'));
    expect(countEl(view).hasAttribute('data-no-results')).toBe(true);
    expect(field(view, 'search').getAttribute('aria-invalid')).toBe('true');
    // 错误信息作 title:悬停可见,也是查找框的可访问描述
    expect(field(view, 'search').title).toMatch(/Invalid regular expression.*foo\(/);
    expect(countEl(view).title).toBe(field(view, 'search').title);
    typeQuery(view, 'foo\\d');
    expect(countEl(view).textContent).not.toBe(t('editor.find.invalid_regex'));
    expect(field(view, 'search').hasAttribute('title')).toBe(false);
    expect(countEl(view).hasAttribute('title')).toBe(false);
    typeQuery(view, 'zzz');
    expect(countEl(view).textContent).toBe(t('editor.find.no_results'));
    typeQuery(view, '');
    expect(countEl(view).textContent).toBe('');
    expect(field(view, 'search').getAttribute('aria-invalid')).not.toBe('true');
  });

  it('超大匹配数封顶 1000+(性能防护),当前匹配仍可显示', async () => {
    const view = await mount('ab '.repeat(1500));
    openFind(view);
    typeQuery(view, 'ab');
    expect(countEl(view).textContent).toBe(t('editor.find.match_total_other', { count: '1000+' }));
    pressInSearch(view, ENTER);
    expect(countEl(view).textContent).toBe(t('editor.find.match_count', { n: 1, total: '1000+' }));
  });

  it('文档变化时计数跟着变', async () => {
    const view = await mount('foo foo\n');
    openFind(view);
    typeQuery(view, 'foo');
    expect(countEl(view).textContent).toBe(t('editor.find.match_total_other', { count: 2 }));
    act(() => view.dispatch({ changes: { from: 0, insert: 'foo ' } }));
    expect(countEl(view).textContent).toBe(t('editor.find.match_total_other', { count: 3 }));
  });

  it('Markdown 源码模式与 Markdown 代码块内嵌编辑器同样有计数', async () => {
    const md = await mount('# foo\n\nfoo bar\n', { forceLanguage: 'markdown', fileName: 'a.md' });
    openFind(md);
    typeQuery(md, 'foo');
    expect(countEl(md).textContent).toBe(t('editor.find.match_total_other', { count: 2 }));
    cleanup();

    // Crepe 代码块:basicSetup + theme 槽位里的 markdownCodeBlockTheme
    const parent = document.body.appendChild(document.createElement('div'));
    const block = new EditorView({ parent, state: EditorState.create({ doc: 'foo\nfoo\nfoo\n', extensions: [basicSetup, markdownCodeBlockTheme] }) });
    openFind(block);
    typeQuery(block, 'foo');
    expect(countEl(block).textContent).toBe(t('editor.find.match_total_other', { count: 3 }));
    block.destroy();
    parent.remove();
  });
});

describe('大文档计数不阻塞按键(VSCode findModel:装饰延迟更新、上限内用装饰跳转)', () => {
  // 约 23 万字符的日志,罕见词只在开头 / 结尾各出现一次
  const FILLER = 'INFO 2026-11-27 worker heartbeat ok\n'.repeat(6400);
  const BIG = `needle at start\n${FILLER}needle at end\n`;

  /** 让每次 performance.now() 前进 5ms:按键里的计数只来得及扫一个分片(模拟 10 万行文档上扫不完)。 */
  function withSlowClock(fn: () => void): void {
    let now = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => (now += 5));
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
  }

  it('按键里只扫一个分片:期间显示已数到的「N+」(一个没数到为「…」,不标红),之后在后台数完显示准确计数', async () => {
    switchLocale('zh');
    const view = await mount(BIG);
    openFind(view);
    withSlowClock(() => typeQuery(view, 'needle'));
    expect(countEl(view).textContent).toBe(t('editor.find.match_total_other', { count: '1+' }));
    await vi.waitFor(() => expect(countEl(view).textContent).toBe(t('editor.find.match_total_other', { count: 2 })));

    withSlowClock(() => typeQuery(view, 'needle at end'));
    expect(countEl(view).textContent).toBe('…');
    expect(countEl(view).hasAttribute('data-no-results')).toBe(false);
    expect(field(view, 'search').getAttribute('aria-invalid')).not.toBe('true');
    await vi.waitFor(() => expect(countEl(view).textContent).toBe(translateCount('editor.find.match_total', 1)));

    withSlowClock(() => typeQuery(view, 'zzz-none'));
    expect(countEl(view).textContent).toBe('…');
    await vi.waitFor(() => expect(countEl(view).textContent).toBe(t('editor.find.no_results')));
    expect(field(view, 'search').getAttribute('aria-invalid')).toBe('true');
  });

  it('计数完成后回车 / ⇧回车 / ⌘G 用已数到的匹配跳转,不再整篇搜索;到头绕回', async () => {
    switchLocale('zh');
    const view = await mount(BIG);
    openFind(view);
    typeQuery(view, 'needle');
    await vi.waitFor(() => expect(countEl(view).textContent).toBe(t('editor.find.match_total_other', { count: 2 })));
    const iterRange = vi.spyOn(Text.prototype, 'iterRange');
    try {
      pressInSearch(view, ENTER);
      expect(view.state.selection.main.from).toBe(0);
      pressInSearch(view, ENTER);
      expect(view.state.selection.main.from).toBe(BIG.lastIndexOf('needle'));
      expect(countEl(view).textContent).toBe(t('editor.find.match_count', { n: 2, total: '2' }));
      pressInSearch(view, ENTER); // 绕回第一个
      expect(view.state.selection.main.from).toBe(0);
      pressInSearch(view, { ...ENTER, shiftKey: true }); // 往前绕到最后一个
      expect(view.state.selection.main.from).toBe(BIG.lastIndexOf('needle'));
      act(() => void findPreviousMatch(view));
      expect(view.state.selection.main.from).toBe(0);
      act(() => void findNextMatch(view));
      expect(view.state.selection.main.from).toBe(BIG.lastIndexOf('needle'));
      // 只有可见区的匹配高亮会读文档,没有跨越大半篇的搜索
      const widest = Math.max(0, ...iterRange.mock.calls.map(([from, to]) => Math.abs((to ?? BIG.length) - from)));
      expect(widest).toBeLessThan(BIG.length / 2);
    } finally {
      iterRange.mockRestore();
    }
  });

  it('大文档编辑时沿用随编辑移动的旧计数(不在按键里重数),约 100ms 后重数为准确值', async () => {
    switchLocale('zh');
    const view = await mount(BIG);
    openFind(view);
    withSlowClock(() => typeQuery(view, 'needle'));
    await vi.waitFor(() => expect(countEl(view).textContent).toBe(t('editor.find.match_total_other', { count: 2 })));
    act(() => view.dispatch({ selection: { anchor: 0, head: 6 } }));
    expect(countEl(view).textContent).toBe(t('editor.find.match_count', { n: 1, total: '2' }));
    act(() => view.dispatch({ changes: { from: 0, insert: 'needle ' } }));
    // 旧匹配随编辑后移,总数仍是 2(新输入的 needle 尚未计入)
    expect([t('editor.find.match_total_other', { count: 2 }), t('editor.find.match_count', { n: 1, total: '2' })]).toContain(
      countEl(view).textContent,
    );
    act(() => view.dispatch({ selection: { anchor: 7, head: 13 } }));
    expect(countEl(view).textContent).toBe(t('editor.find.match_count', { n: 1, total: '2' }));
    // 时钟停住:防抖到期后的重数在一个分片里扫完(扫完即更新计数,不依赖后续分片)
    const frozen = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      await vi.waitFor(() => expect(countEl(view).textContent).toBe(t('editor.find.match_count', { n: 2, total: '3' })));
    } finally {
      frozen.mockRestore();
    }
  });
});

describe('查找快捷键(VSCode:替换 ⌥⌘F / Ctrl+H;切换选项 ⌥⌘C/W/R / Alt+C/W/R)', () => {
  it('Markdown 代码块:Ctrl+H 打开查找面板并聚焦替换框(CodeEditor 的替换键经命令注册表,见 editor-find-keybindings)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ state: EditorState.create({ doc: FOO_154, extensions: [basicSetup, markdownCodeBlockTheme] }), parent });
    try {
      expect(key(view, { key: 'h', ctrlKey: true, keyCode: 72 })).toBe(true);
      expect(view.dom.querySelector('.cm-search')).not.toBeNull();
      expect(document.activeElement).toBe(field(view, 'replace'));
      // 面板已开、焦点在查找框:再按仍跳到替换框
      act(() => field(view, 'search').focus());
      key(view, { key: 'h', ctrlKey: true, keyCode: 72 }, 'search-panel');
      expect(document.activeElement).toBe(field(view, 'replace'));
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it('Alt+C / Alt+W / Alt+R 翻转大小写 / 全字 / 正则,复选框同步;面板未开时不吞键', async () => {
    const view = await mount(FOO_154);
    expect(key(view, { key: 'c', altKey: true, keyCode: 67 })).toBe(false);
    openFind(view);
    expect(key(view, { key: 'c', altKey: true, keyCode: 67 }, 'search-panel')).toBe(true);
    expect(getSearchQuery(view.state).caseSensitive).toBe(true);
    expect(field(view, 'case').checked).toBe(true);
    key(view, { key: 'w', altKey: true, keyCode: 87 }, 'search-panel');
    expect(getSearchQuery(view.state).wholeWord).toBe(true);
    expect(field(view, 'word').checked).toBe(true);
    key(view, { key: 'r', altKey: true, keyCode: 82 }, 'search-panel');
    expect(getSearchQuery(view.state).regexp).toBe(true);
    expect(field(view, 're').checked).toBe(true);
    // 编辑区获焦时同样生效(VSCode 同),再按翻回
    key(view, { key: 'c', altKey: true, keyCode: 67 });
    expect(getSearchQuery(view.state).caseSensitive).toBe(false);
    expect(field(view, 'case').checked).toBe(false);
  });

  it('切换选项后计数按新选项重算', async () => {
    const view = await mount('Foo foo FOO\n');
    openFind(view);
    typeQuery(view, 'foo');
    expect(countEl(view).textContent).toBe(t('editor.find.match_total_other', { count: 3 }));
    key(view, { key: 'c', altKey: true, keyCode: 67 }, 'search-panel');
    expect(countEl(view).textContent).toBe(t('editor.find.match_total_one', { count: 1 }));
  });
});

describe('查找历史(查找框 ↑ / ↓,按窗口共享)', () => {
  it('回车提交的词进历史;↑ 翻到更早,↓ 回到更新,越过最新清空', async () => {
    const view = await mount(FOO_154);
    openFind(view);
    typeQuery(view, 'foo1');
    pressInSearch(view, ENTER);
    typeQuery(view, 'foo2');
    pressInSearch(view, ENTER);
    typeQuery(view, 'draft');
    pressInSearch(view, { key: 'ArrowUp', keyCode: 38 });
    expect(field(view, 'search').value).toBe('foo2');
    expect(getSearchQuery(view.state).search).toBe('foo2');
    pressInSearch(view, { key: 'ArrowUp', keyCode: 38 });
    expect(field(view, 'search').value).toBe('foo1');
    pressInSearch(view, { key: 'ArrowDown', keyCode: 40 });
    expect(field(view, 'search').value).toBe('foo2');
  });

  it('同窗另一个编辑器的查找框能翻到这里提交过的词', async () => {
    const a = await mount(FOO_154);
    openFind(a);
    typeQuery(a, 'foo42');
    pressInSearch(a, ENTER);
    cleanup();
    const b = await mount('x\n', { fileName: 'b.ts' });
    openFind(b);
    pressInSearch(b, { key: 'ArrowUp', keyCode: 38 });
    expect(field(b, 'search').value).toBe('foo42');
  });

  it('关闭面板时查找框里的词也进历史', async () => {
    const view = await mount(FOO_154);
    openFind(view);
    typeQuery(view, 'closed-term');
    key(view, { key: 'Escape', keyCode: 27 }, 'search-panel');
    expect(view.dom.querySelector('.cm-search')).toBeNull();
    expect(editorFindHistory.entries()).toContain('closed-term');
  });
});

describe('输入法组字中的按键不当面板键(拼音组字时 Esc 是取消组字,不关查找条)', () => {
  /** 在查找 / 替换框里派发真实 keydown(冒泡经默认面板的 keydown 处理到 document)。 */
  function pressIn(input: HTMLInputElement, init: KeyboardEventInit): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
      input.dispatchEvent(ev);
    });
    return ev;
  }
  const COMPOSING_ESC = { key: 'Escape', keyCode: 229, isComposing: true } as const;

  it('查找框:组字中按 Esc(isComposing / keyCode 229)面板不关,事件不冒泡到工作台;组字结束后 Esc 照常关闭', async () => {
    const view = await mount(FOO_154);
    openFind(view);
    typeQuery(view, 'foo');
    const onDocKey = vi.fn();
    document.addEventListener('keydown', onDocKey);
    try {
      const ev = pressIn(field(view, 'search'), COMPOSING_ESC);
      // 只有 keyCode 229(部分输入法下组字结束那次按键 isComposing 已为 false)同样不关
      pressIn(field(view, 'search'), { key: 'Escape', keyCode: 229 });
      pressIn(field(view, 'search'), { key: 'Escape', keyCode: 27, isComposing: true });
      expect(view.dom.querySelector('.cm-search')).not.toBeNull();
      expect(ev.defaultPrevented).toBe(false); // 输入法照常处理
      expect(onDocKey).not.toHaveBeenCalled();
      pressIn(field(view, 'search'), { key: 'Escape', keyCode: 27 });
      expect(view.dom.querySelector('.cm-search')).toBeNull();
    } finally {
      document.removeEventListener('keydown', onDocKey);
    }
  });

  it('替换框:组字中按 Esc 面板不关', async () => {
    const view = await mount(FOO_154);
    openFind(view);
    pressIn(field(view, 'replace'), COMPOSING_ESC);
    expect(view.dom.querySelector('.cm-search')).not.toBeNull();
    pressIn(field(view, 'replace'), { key: 'Escape', keyCode: 27 });
    expect(view.dom.querySelector('.cm-search')).toBeNull();
  });

  it('组字中按 Enter(确认候选)不跳到下一个匹配、不进历史;组字中方向键不翻历史', async () => {
    const view = await mount(FOO_154);
    openFind(view);
    typeQuery(view, 'foo1');
    const before = view.state.selection.main.from;
    pressIn(field(view, 'search'), { key: 'Enter', keyCode: 229, isComposing: true });
    expect(view.state.selection.main.from).toBe(before);
    expect(editorFindHistory.entries()).not.toContain('foo1');
    editorFindHistory.add('older');
    pressIn(field(view, 'search'), { key: 'ArrowUp', keyCode: 229, isComposing: true });
    expect(field(view, 'search').value).toBe('foo1');
  });

  it('Markdown 代码块(Crepe 的 CodeMirror,经 markdownCodeBlockTheme)同样:组字中 Esc 不关', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ state: EditorState.create({ doc: FOO_154, extensions: [basicSetup, markdownCodeBlockTheme] }), parent });
    try {
      openFind(view);
      pressIn(field(view, 'search'), COMPOSING_ESC);
      pressIn(field(view, 'replace'), COMPOSING_ESC);
      expect(view.dom.querySelector('.cm-search')).not.toBeNull();
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe('强制颜色下当前匹配与其它匹配可区分', () => {
  it('forced-colors 媒体查询:当前匹配 2px Highlight 实线轮廓,其它匹配 1px CanvasText 虚线,选区用 Highlight', async () => {
    const view = await mount(FOO_154);
    openFind(view);
    const css = injectedCss().replace(/\s+/g, ' ');
    const media = css.match(/@media \(forced-colors: active\) \{(.*?\})\s*\}/g)?.join(' ') ?? '';
    expect(media).toMatch(/\.cm-searchMatch-selected[^{]*\{[^}]*outline: 2px solid Highlight/);
    expect(media).toMatch(/\.cm-searchMatch[^-{][^{]*\{[^}]*outline: 1px dashed CanvasText/);
    expect(media).toMatch(/\.cm-selectionBackground[^{]*\{[^}]*Highlight/);
  });
});
