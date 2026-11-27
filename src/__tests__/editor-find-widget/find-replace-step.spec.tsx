// @vitest-environment jsdom
// BDD:查找面板的「替换」一次一步、空匹配(正则 ^ / $ / x* / \b)回车逐个前进(对齐 VSCode findModel 的 replace() 与
// _moveToNextMatch / _moveToPrevMatch 的空匹配处理)。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { undo } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { markdownCodeBlockTheme } from '../../panels/Editor/code-editor-theme';
import { editorFindHistory } from '../../panels/Editor/find-widget-model';
import { findNextMatch, findPreviousMatch, openFindPanel } from '../../panels/Editor/codemirror-find';
import { ThemeContext } from '../../theme/ThemeProvider';
import { setLocale, t } from '../../i18n';

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

async function mount(value: string): Promise<EditorView> {
  const utils = render(
    <ThemeContext.Provider value={{ mode: 'dark', resolved: 'dark', setMode: () => {} }}>
      <CodeEditor tabId="/replace.txt" value={value} fileName="replace.txt" />
    </ThemeContext.Provider>,
  );
  await act(async () => {});
  const el = utils.container.querySelector<HTMLElement>('.cm-editor');
  if (!el) throw new Error('no .cm-editor');
  const view = EditorView.findFromDOM(el)!;
  act(() => void openFindPanel(view));
  return view;
}

function field(view: EditorView, name: 'search' | 'replace' | 'case' | 're'): HTMLInputElement {
  const el = view.dom.querySelector<HTMLInputElement>(`.cm-search input[name="${name}"]`);
  if (!el) throw new Error(`no field ${name}`);
  return el;
}

/** 在查找 / 替换框里输入(面板在 keyup 时提交查询)。 */
function type(view: EditorView, name: 'search' | 'replace', text: string): void {
  act(() => {
    const input = field(view, name);
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keyup', { key: text.slice(-1) || 'Backspace', bubbles: true }));
  });
}

function enter(view: EditorView, name: 'search' | 'replace', shiftKey = false): void {
  act(() => {
    field(view, name).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, shiftKey, bubbles: true, cancelable: true }));
  });
}

function clickButton(view: EditorView, name: 'replace' | 'replaceAll' | 'next' | 'prev'): void {
  const button = view.dom.querySelector<HTMLButtonElement>(`.cm-search button[name="${name}"]`);
  if (!button) throw new Error(`no button ${name}`);
  act(() => button.click());
}

function regexp(view: EditorView): void {
  act(() => field(view, 're').click());
}

const sel = (view: EditorView) => [view.state.selection.main.from, view.state.selection.main.to];
const doc = (view: EditorView) => view.state.doc.toString();
const countText = (view: EditorView) => view.dom.querySelector('.cm-search .cm-search-count')?.textContent;

beforeEach(() => {
  setLocale('zh');
  editorFindHistory.clear();
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => cleanup());

describe('替换一次一步(VSCode replace():选区是匹配就替换并移到下一个匹配,否则先选中下一个匹配)', () => {
  it('替换按钮:第一次选中匹配,之后每按一次替换一处并选中下一处', async () => {
    const view = await mount('food a food b food c\n');
    type(view, 'search', 'food');
    type(view, 'replace', 'MEAL');
    clickButton(view, 'replace'); // 光标不在匹配上:只选中第一个
    expect(doc(view)).toBe('food a food b food c\n');
    expect(sel(view)).toEqual([0, 4]);
    clickButton(view, 'replace');
    expect(doc(view)).toBe('MEAL a food b food c\n');
    expect(sel(view)).toEqual([7, 11]);
    expect(countText(view)).toBe(t('editor.find.match_count', { n: 1, total: '2' }));
    clickButton(view, 'replace');
    expect(doc(view)).toBe('MEAL a MEAL b food c\n');
    expect(sel(view)).toEqual([14, 18]);
    clickButton(view, 'replace');
    expect(doc(view)).toBe('MEAL a MEAL b MEAL c\n');
  });

  it('替换框回车同替换按钮', async () => {
    const view = await mount('food a food b\n');
    type(view, 'search', 'food');
    type(view, 'replace', 'MEAL');
    enter(view, 'replace');
    enter(view, 'replace');
    expect(doc(view)).toBe('MEAL a food b\n');
    expect(sel(view)).toEqual([7, 11]);
    enter(view, 'replace');
    expect(doc(view)).toBe('MEAL a MEAL b\n');
  });

  it('替换结果仍匹配(不区分大小写 id=7312 → ID=7312):从替换结尾之后继续,不卡在同一处', async () => {
    const view = await mount('id=7312\nx id=7312\ny id=7312\n');
    type(view, 'search', 'id=7312');
    type(view, 'replace', 'ID=7312');
    for (let i = 0; i < 4; i++) clickButton(view, 'replace');
    expect(doc(view)).toBe('ID=7312\nx ID=7312\ny ID=7312\n');
  });

  it('撤销一步只撤回一次替换', async () => {
    const view = await mount('food a food b\n');
    type(view, 'search', 'food');
    type(view, 'replace', 'MEAL');
    clickButton(view, 'replace');
    clickButton(view, 'replace');
    clickButton(view, 'replace');
    expect(doc(view)).toBe('MEAL a MEAL b\n');
    act(() => void undo(view));
    expect(doc(view)).toBe('MEAL a food b\n');
    act(() => void undo(view));
    expect(doc(view)).toBe('food a food b\n');
  });

  it('正则捕获组 $1 / $2 照常替换', async () => {
    const view = await mount('a=1\nb=2\n');
    regexp(view);
    type(view, 'search', '(\\w)=(\\d)');
    type(view, 'replace', '$2:$1');
    for (let i = 0; i < 3; i++) clickButton(view, 'replace');
    expect(doc(view)).toBe('1:a\n2:b\n');
  });

  it('大文档计数分片期间(计数未完成)替换同样一次一步', async () => {
    const filler = 'INFO 2026-11-27 worker heartbeat ok\n'.repeat(6400);
    const view = await mount(`food\n${filler}food\n`);
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 5));
    try {
      type(view, 'search', 'food');
      type(view, 'replace', 'MEAL');
      clickButton(view, 'replace');
      expect(sel(view)).toEqual([0, 4]);
      clickButton(view, 'replace');
      expect(doc(view).startsWith('MEAL\n')).toBe(true);
      expect(sel(view)[0]).toBe(doc(view).lastIndexOf('food'));
      clickButton(view, 'replace');
      expect(doc(view).endsWith('MEAL\n')).toBe(true);
      expect(doc(view)).not.toContain('food');
    } finally {
      clock.mockRestore();
    }
  });

  it('替换 ^ 为「> 」一次一行;全部替换 ^ 每行一次', async () => {
    const view = await mount('a\nb\nc');
    regexp(view);
    type(view, 'search', '^');
    type(view, 'replace', '> ');
    clickButton(view, 'replace'); // 光标在第 1 行行首空匹配上:直接替换
    expect(doc(view)).toBe('> a\nb\nc');
    clickButton(view, 'replace');
    expect(doc(view)).toBe('> a\n> b\nc');
    clickButton(view, 'replace');
    expect(doc(view)).toBe('> a\n> b\n> c');
    cleanup();

    const all = await mount('a\nb\nc');
    regexp(all);
    type(all, 'search', '^');
    type(all, 'replace', '> ');
    clickButton(all, 'replaceAll');
    expect(doc(all)).toBe('> a\n> b\n> c');
  });
});

describe('空匹配回车逐个前进(VSCode _moveToNextMatch:下一个匹配为空且就在选区处 → 从下一位置再找)', () => {
  it('^:回车逐行,到尾绕回;⇧回车逐行往回', async () => {
    const view = await mount('a\nb\nc');
    regexp(view);
    type(view, 'search', '^');
    const starts: number[] = [];
    for (let i = 0; i < 4; i++) {
      enter(view, 'search');
      starts.push(sel(view)[0]!);
    }
    expect(starts).toEqual([2, 4, 0, 2]);
    expect(countText(view)).toBe(t('editor.find.match_count', { n: 2, total: '3' }));
    const back: number[] = [];
    for (let i = 0; i < 3; i++) {
      enter(view, 'search', true);
      back.push(sel(view)[0]!);
    }
    expect(back).toEqual([0, 4, 2]);
  });

  it('$ / x* / \\b 与 ⌘G(findNextMatch)、面板按钮同样前进', async () => {
    const view = await mount('ab\ncd\n');
    regexp(view);
    type(view, 'search', '$');
    const ends: number[] = [];
    for (let i = 0; i < 3; i++) {
      act(() => void findNextMatch(view));
      ends.push(sel(view)[0]!);
    }
    expect(ends).toEqual([2, 5, 6]);
    act(() => void findPreviousMatch(view));
    expect(sel(view)).toEqual([5, 5]);

    type(view, 'search', '\\b');
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    const bounds: number[] = [];
    for (let i = 0; i < 3; i++) {
      clickButton(view, 'next');
      bounds.push(sel(view)[0]!);
    }
    expect(bounds).toEqual([2, 3, 5]);
    clickButton(view, 'prev');
    expect(sel(view)).toEqual([3, 3]);

    type(view, 'search', 'x*');
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    enter(view, 'search');
    expect(sel(view)).toEqual([1, 1]);
  });

  it('计数封顶 1000+ 时(退回逐次搜索)^ 回车同样逐行', async () => {
    const view = await mount('x\n'.repeat(1500));
    regexp(view);
    type(view, 'search', '^');
    expect(countText(view)).toBe(t('editor.find.match_count', { n: 1, total: '1000+' }));
    act(() => view.dispatch({ selection: { anchor: 1200 * 2 } }));
    enter(view, 'search');
    expect(sel(view)).toEqual([1201 * 2, 1201 * 2]);
    enter(view, 'search', true);
    expect(sel(view)).toEqual([1200 * 2, 1200 * 2]);
    act(() => void findNextMatch(view));
    expect(sel(view)).toEqual([1201 * 2, 1201 * 2]);
  });

  it('Markdown 代码块(Crepe 的 CodeMirror)查找框回车同样逐行', () => {
    const parent = document.body.appendChild(document.createElement('div'));
    const view = new EditorView({ parent, state: EditorState.create({ doc: 'a\nb\nc', extensions: [basicSetup, markdownCodeBlockTheme] }) });
    act(() => void openFindPanel(view));
    regexp(view);
    type(view, 'search', '^');
    enter(view, 'search');
    enter(view, 'search');
    expect(sel(view)).toEqual([4, 4]);
    view.destroy();
    parent.remove();
  });
});
