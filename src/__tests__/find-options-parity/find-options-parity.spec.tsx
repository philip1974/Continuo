// @vitest-environment jsdom
// BDD: find-options-parity —— 三处查找(编辑器查找面板、在文件中查找、终端 / Markdown 查找条)的选项名称、tooltip 快捷键与
// ⌥⌘C / ⌥⌘W / ⌥⌘R(Windows / Linux Alt+C / W / R)切换一致(对齐 VSCode findInput)。
// jsdom 平台非 mac:组件内走 Alt 变体;mac 变体在按键匹配处显式传 platform。
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { getSearchQuery } from '@codemirror/search';

vi.mock('@/lib/co-api', () => ({
  coApi: { search: { start: vi.fn(async () => ({ ok: true })), cancel: vi.fn(async () => ({ ok: true })), onEvent: () => () => {} } },
}));
vi.mock('@/plugins/co-app', () => ({ coApp: { editor: { openFile: vi.fn() } } }));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

import { getLocale, notifyLocaleChange, setLocale, t, type Locale } from '@/i18n';
import { findOptionHotkey, matchFindOptionHotkey } from '@/lib/find-options';
import { SearchPanel } from '@/panels/Search/SearchPanel';
import { __resetSearchForTest, useSearchStore } from '@/panels/Search/search-store';
import { TerminalSearchBar } from '@/panels/Terminal/TerminalSearchBar';
import type { SearchApi } from '@/panels/Terminal/useTerminal';
import { CodeEditor } from '@/panels/Editor/CodeEditor';
import { ThemeContext } from '@/theme/ThemeProvider';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

function switchLocale(locale: Locale): void {
  act(() => {
    setLocale(locale);
    notifyLocaleChange();
  });
}

let original: Locale;
beforeEach(() => {
  original = getLocale();
  switchLocale('zh');
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  __resetSearchForTest();
  switchLocale(original);
});

/** 平台按键:mac ⌥⌘<字母>(e.key 是 ⌥ 产生的特殊字符),其它 Alt+<字母>。 */
function optionKey(letter: 'c' | 'w' | 'r', mac: boolean): KeyboardEventInit {
  const macChar = { c: 'ç', w: '∑', r: '®' }[letter];
  return mac
    ? { key: macChar, code: `Key${letter.toUpperCase()}`, metaKey: true, altKey: true, bubbles: true, cancelable: true }
    : { key: letter, code: `Key${letter.toUpperCase()}`, altKey: true, bubbles: true, cancelable: true };
}

const LABEL = {
  caseSensitive: () => t('find.option.match_case'),
  wholeWord: () => t('find.option.whole_word'),
  regex: () => t('find.option.regex'),
};

describe('切换键匹配(共享)', () => {
  it('mac ⌥⌘C / ⌥⌘W / ⌥⌘R 按物理键识别(e.key 为 ç / ∑ / ®)', () => {
    expect(matchFindOptionHotkey(new KeyboardEvent('keydown', optionKey('c', true)), 'mac')).toBe('caseSensitive');
    expect(matchFindOptionHotkey(new KeyboardEvent('keydown', optionKey('w', true)), 'mac')).toBe('wholeWord');
    expect(matchFindOptionHotkey(new KeyboardEvent('keydown', optionKey('r', true)), 'mac')).toBe('regex');
    // mac 上单按 ⌥C 不是切换键(会输入 ç)
    expect(matchFindOptionHotkey(new KeyboardEvent('keydown', optionKey('c', false)), 'mac')).toBeNull();
  });

  it('Windows / Linux Alt+C / W / R;多带修饰键不算', () => {
    expect(matchFindOptionHotkey(new KeyboardEvent('keydown', optionKey('c', false)), 'other')).toBe('caseSensitive');
    expect(matchFindOptionHotkey(new KeyboardEvent('keydown', optionKey('r', false)), 'other')).toBe('regex');
    expect(matchFindOptionHotkey(new KeyboardEvent('keydown', { ...optionKey('c', false), shiftKey: true }), 'other')).toBeNull();
    expect(matchFindOptionHotkey(new KeyboardEvent('keydown', { ...optionKey('c', false), ctrlKey: true }), 'other')).toBeNull();
    expect(findOptionHotkey('wholeWord', 'mac')).toBe('mod+alt+w');
    expect(findOptionHotkey('wholeWord', 'other')).toBe('alt+w');
  });
});

describe('在文件中查找(⇧⌘F)', () => {
  it('查询框里 Alt+C / W / R 切换区分大小写 / 全字匹配 / 正则', () => {
    render(<SearchPanel />);
    const box = screen.getByRole('textbox', { name: t('panels.search.query_label') });
    fireEvent.keyDown(box, optionKey('c', false));
    fireEvent.keyDown(box, optionKey('w', false));
    fireEvent.keyDown(box, optionKey('r', false));
    const s = useSearchStore.getState();
    expect([s.matchCase, s.wholeWord, s.isRegex]).toEqual([true, true, true]);
    fireEvent.keyDown(box, optionKey('c', false));
    expect(useSearchStore.getState().matchCase).toBe(false);
  });

  it('选项按钮用共享名称,tooltip 带快捷键', () => {
    render(<SearchPanel />);
    expect(screen.getByRole('group', { name: t('find.options_group') })).toBeTruthy();
    expect(screen.getByRole('button', { name: LABEL.caseSensitive() }).getAttribute('title')).toBe(`${LABEL.caseSensitive()} (Alt+C)`);
    expect(screen.getByRole('button', { name: LABEL.wholeWord() }).getAttribute('title')).toBe(`${LABEL.wholeWord()} (Alt+W)`);
    expect(screen.getByRole('button', { name: LABEL.regex() }).getAttribute('title')).toBe(`${LABEL.regex()} (Alt+R)`);
  });
});

function makeApi(overrides: Partial<SearchApi> = {}): SearchApi {
  return {
    isOpen: true,
    term: '',
    options: { regex: false, caseSensitive: false, wholeWord: false },
    result: { index: -1, count: 0 },
    focusRequest: 1,
    open: vi.fn(),
    close: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    setTerm: vi.fn(),
    setOptions: vi.fn(),
    clearActiveDecoration: vi.fn(),
    ...overrides,
  };
}

describe('终端 / Markdown 查找条', () => {
  it('查找框与选项按钮上 Alt+C / W / R 切换对应选项', () => {
    const api = makeApi();
    render(<TerminalSearchBar searchApi={api} onClose={vi.fn()} />);
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, optionKey('r', false));
    expect(api.setOptions).toHaveBeenLastCalledWith({ regex: true, caseSensitive: false, wholeWord: false });
    fireEvent.keyDown(box, optionKey('c', false));
    expect(api.setOptions).toHaveBeenLastCalledWith({ regex: false, caseSensitive: true, wholeWord: false });
    fireEvent.keyDown(screen.getByRole('button', { name: LABEL.regex() }), optionKey('w', false));
    expect(api.setOptions).toHaveBeenLastCalledWith({ regex: false, caseSensitive: false, wholeWord: true });
  });

  it('选项按钮用共享名称,tooltip 带快捷键', () => {
    render(<TerminalSearchBar searchApi={makeApi()} onClose={vi.fn()} />);
    expect(screen.getByRole('group', { name: t('find.options_group') })).toBeTruthy();
    expect(screen.getByRole('button', { name: LABEL.caseSensitive() }).getAttribute('title')).toBe(`${LABEL.caseSensitive()} (Alt+C)`);
    expect(screen.getByRole('button', { name: LABEL.wholeWord() }).getAttribute('title')).toBe(`${LABEL.wholeWord()} (Alt+W)`);
    expect(screen.getByRole('button', { name: LABEL.regex() }).getAttribute('title')).toBe(`${LABEL.regex()} (Alt+R)`);
  });
});

async function mountEditor(): Promise<EditorView> {
  const utils = render(
    <ThemeContext.Provider value={{ mode: 'dark', resolved: 'dark', setMode: () => {} }}>
      <CodeEditor tabId="/find.ts" value={'const a = 1;\n'} fileName="find.ts" />
    </ThemeContext.Provider>,
  );
  await act(async () => {});
  return EditorView.findFromDOM(utils.container.querySelector<HTMLElement>('.cm-editor')!)!;
}

describe('编辑器查找面板(⌘F)', () => {
  it('选项复选框用共享名称,tooltip 带快捷键;按钮有 title', async () => {
    const view = await mountEditor();
    act(() => void runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, keyCode: 70 }), 'editor'));
    const labelOf = (name: string) => view.dom.querySelector(`.cm-search input[name="${name}"]`)!.closest('label')!;
    expect(screen.getByRole('checkbox', { name: LABEL.caseSensitive() }).getAttribute('name')).toBe('case');
    expect(screen.getByRole('checkbox', { name: LABEL.wholeWord() }).getAttribute('name')).toBe('word');
    expect(screen.getByRole('checkbox', { name: LABEL.regex() }).getAttribute('name')).toBe('re');
    expect(labelOf('case').getAttribute('title')).toBe(`${LABEL.caseSensitive()} (Alt+C)`);
    expect(labelOf('word').getAttribute('title')).toBe(`${LABEL.wholeWord()} (Alt+W)`);
    expect(labelOf('re').getAttribute('title')).toBe(`${LABEL.regex()} (Alt+R)`);
    const button = (name: string) => view.dom.querySelector(`.cm-search button[name="${name}"]`)!;
    expect(button('next').getAttribute('title')).toBe(`${t('editor.cm.next')} (Enter)`);
    expect(button('prev').getAttribute('title')).toBe(`${t('editor.cm.previous')} (Shift+Enter)`);
    expect(button('select').getAttribute('title')).toBe(t('editor.cm.all'));
    expect(button('close').getAttribute('title')).toBe(`${t('editor.cm.close')} (Esc)`);
    // 切换键仍是同一组(Alt+C)
    act(() => void runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', altKey: true, keyCode: 67 }), 'editor'));
    expect(getSearchQuery(view.state).caseSensitive).toBe(true);
  });
});

/** 选项组内按钮:[可访问名, 字形, aria-pressed]。 */
function optionButtons(group: HTMLElement): Array<[string | null, string, string | null]> {
  return [...group.querySelectorAll('button')].map((b) => [b.getAttribute('aria-label'), b.textContent ?? '', b.getAttribute('aria-pressed')]);
}

describe('选项 toggle 顺序 / 字形 / 样式统一(VSCode Aa / ab / .*)', () => {
  const ORDER = () => [LABEL.caseSensitive(), LABEL.wholeWord(), LABEL.regex()];

  it('终端 / Markdown 查找条与在文件中查找:同顺序 Aa / ab / .*、同样式', () => {
    const term = render(<TerminalSearchBar searchApi={makeApi({ options: { regex: true, caseSensitive: false, wholeWord: false } })} onClose={vi.fn()} />);
    const termGroup = within(term.container).getByRole('group', { name: t('find.options_group') });
    expect(optionButtons(termGroup)).toEqual([
      [ORDER()[0], 'Aa', 'false'],
      [ORDER()[1], 'ab', 'false'],
      [ORDER()[2], '.*', 'true'],
    ]);
    const search = render(<SearchPanel />);
    const searchGroup = within(search.container).getByRole('group', { name: t('find.options_group') });
    expect(optionButtons(searchGroup).map(([name, glyph]) => [name, glyph])).toEqual([
      [ORDER()[0], 'Aa'],
      [ORDER()[1], 'ab'],
      [ORDER()[2], '.*'],
    ]);
    // 同一组件:按钮 className 逐个相同
    const classes = (g: HTMLElement) => [...g.querySelectorAll('button')].map((b) => b.className);
    expect(classes(termGroup)).toEqual(classes(searchGroup));
  });

  it('编辑器查找面板:选项为同顺序 Aa / ab / .* 的 toggle(可访问名 = 选项名,勾选态随查找状态),紧跟查找框', async () => {
    const view = await mountEditor();
    act(() => void runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, keyCode: 70 }), 'editor'));
    const group = within(view.dom).getByRole('group', { name: t('find.options_group') });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('name'))).toEqual(['case', 'word', 're']);
    expect(boxes.map((b) => within(group).getByRole('checkbox', { name: ORDER()[boxes.indexOf(b)] }) === b)).toEqual([true, true, true]);
    expect([...group.querySelectorAll('[aria-hidden="true"]')].map((g) => g.textContent)).toEqual(['Aa', 'ab', '.*']);
    // 选项组紧跟查找框(与计数)之后,在「下一个」按钮之前(同终端 / 在文件中查找:输入框 → 选项)
    const next = view.dom.querySelector('.cm-search button[name="next"]')!;
    expect(group.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // ⌥⌘W / Alt+W 切换后勾选态同步
    act(() => void runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', altKey: true, keyCode: 87 }), 'editor'));
    expect(getSearchQuery(view.state).wholeWord).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
    // 点击 toggle 翻转查找状态
    act(() => (boxes[0] as HTMLInputElement).click());
    expect(getSearchQuery(view.state).caseSensitive).toBe(true);
  });
});

describe('选项名称三语统一(VSCode Match Case / Match Whole Word / Use Regular Expression)', () => {
  it('共享键取 VSCode 同义文案;各界面的旧重复键已删除', () => {
    const pick = (c: Readonly<Record<string, string>>) => [c['find.option.match_case'], c['find.option.whole_word'], c['find.option.regex']];
    expect(pick(en)).toEqual(['Match Case', 'Match Whole Word', 'Use Regular Expression']);
    expect(pick(zh)).toEqual(['区分大小写', '全字匹配', '使用正则表达式']);
    expect(pick(ko)).toEqual(['대/소문자 구분', '단어 단위로', '정규식 사용']);
    const stale = [
      'editor.cm.match_case',
      'editor.cm.regexp',
      'editor.cm.by_word',
      'panels.terminal.search.options_group',
      'panels.terminal.search.regex',
      'panels.terminal.search.case_sensitive',
      'panels.terminal.search.whole_word',
    ];
    for (const catalog of [en, zh, ko]) for (const key of stale) expect(Object.hasOwn(catalog, key)).toBe(false);
  });
});
