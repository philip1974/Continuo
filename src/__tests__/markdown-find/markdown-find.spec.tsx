// @vitest-environment jsdom
// Markdown 编辑 / 预览模式 ⌘F 查找(真实 Crepe)。行为见同目录 README。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { buildFindRegExp, findTextMatches } from '../../panels/Editor/markdown-find';
import { detectPlatform } from '../../plugins/command-palette/format-hotkey';
import { t } from '../../i18n';
import { editorFindHistory } from '../../panels/Editor/find-widget-model';
import { clearMarkdownFindSessions } from '../../panels/Editor/markdown-find';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { TextSelection } from '@milkdown/kit/prose/state';

const MOD = detectPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true };

const mocks = vi.hoisted(() => ({ instances: [] as CrepeType[] }));
vi.mock('@milkdown/crepe', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@milkdown/crepe')>();
  class RecordingCrepe extends mod.Crepe {
    constructor(...args: ConstructorParameters<typeof mod.Crepe>) {
      super(...args);
      mocks.instances.push(this);
    }
  }
  return { ...mod, Crepe: RecordingCrepe };
});
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({ coApi: { fs: { readImage: vi.fn() } } }));

// jsdom 没有 Range 的布局接口(ProseMirror 量坐标 / 选区要用),与其它编辑器规范同样补上。
beforeEach(() => {
  // 打开着的 tab(查找状态按 tab 保留;tab 已关闭时卸载即丢弃)
  useEditorStore.setState({ tabs: [createTab('/w/a.md', ''), createTab('/w/b.md', '')] });
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  mocks.instances.length = 0;
  clearMarkdownFindSessions();
  editorFindHistory.clear();
});

interface PmView {
  readonly state: {
    readonly doc: { textBetween(from: number, to: number): string; readonly content: { readonly size: number } };
    readonly selection: { readonly from: number; readonly to: number };
    readonly tr: { insertText(text: string, from: number, to?: number): unknown; setSelection(sel: unknown): unknown };
  };
  dispatch(tr: unknown): void;
}

async function mount(markdown: string, readonly = false, tabId = '/w/a.md') {
  const utils = render(<MilkdownEditor tabId={tabId} fileName={tabId} defaultValue={markdown} readonly={readonly} />);
  for (let i = 0; i < 100; i++) {
    const crepe = mocks.instances.at(-1);
    try {
      const view = crepe?.editor.ctx.get<PmView, 'editorView'>('editorView');
      if (view?.state) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
        const pm = utils.container.querySelector<HTMLElement>('.ProseMirror')!;
        return { ...utils, view, pm };
      }
    } catch {
      /* 未就绪 */
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error('Crepe 未挂载');
}

// 标签同代码编辑器查找面板「查找」(不是终端的「搜索」)
const findInput = () => screen.getByRole('textbox', { name: t('editor.cm.find') }) as HTMLInputElement;
const queryFindInput = () => screen.queryByRole('textbox', { name: t('editor.cm.find') });
const countText = () => screen.getByRole('status').textContent;

function openFind(target: HTMLElement): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true, cancelable: true, ...MOD });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

function typeQuery(value: string) {
  act(() => {
    fireEvent.change(findInput(), { target: { value } });
  });
}

const DOC = '# Alpha title\n\nalpha one and **alpha** two\n\nbeta ALPHA\n';

describe('查找匹配(纯函数)', () => {
  it('字面量默认不区分大小写;区分大小写 / 全字 / 正则', () => {
    const lit = buildFindRegExp({ term: 'a.b', caseSensitive: false, wholeWord: false, regex: false })!;
    expect('A.B axb'.match(lit)).toEqual(['A.B']);
    const cs = buildFindRegExp({ term: 'Al', caseSensitive: true, wholeWord: false, regex: false })!;
    expect('al Al'.match(cs)).toEqual(['Al']);
    const ww = buildFindRegExp({ term: 'al', caseSensitive: false, wholeWord: true, regex: false })!;
    expect('al alpha _al al_ é'.match(ww)).toEqual(['al']);
    const re = buildFindRegExp({ term: 'a\\d+', caseSensitive: false, wholeWord: false, regex: true })!;
    expect('a1 a22 b3'.match(re)).toEqual(['a1', 'a22']);
  });

  it('空查询 / 非法正则 → null', () => {
    expect(buildFindRegExp({ term: '', caseSensitive: false, wholeWord: false, regex: false })).toBeNull();
    expect(buildFindRegExp({ term: '(', caseSensitive: false, wholeWord: false, regex: true })).toBeNull();
    // 全字包裹不能把本身非法的用户正则凑成合法(与查找条「正则表达式无效」同一判据)
    expect(buildFindRegExp({ term: 'a)|(?:b', caseSensitive: false, wholeWord: true, regex: true })).toBeNull();
  });

  it('文本内匹配跳过空匹配、到上限即停', () => {
    expect(findTextMatches('aaa', /x*/g, 10)).toEqual([]);
    expect(findTextMatches('abab', /b/g, 10)).toEqual([[1, 2], [3, 4]]);
    expect(findTextMatches('bbbb', /b/g, 3)).toHaveLength(3);
  });
});

describe('Markdown 编辑模式 ⌘F', () => {
  it('⌘F 打开查找条并聚焦,事件被编辑器拦下;输入即高亮全部匹配并显示「当前 / 总数」(跨粗体边界)', async () => {
    const { pm, container } = await mount(DOC);
    const ev = openFind(pm);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(findInput());
    typeQuery('alpha');
    expect(countText()).toBe(t('editor.find.match_count', { n: 1, total: '4' }));
    expect(container.querySelectorAll('.co-find-match')).toHaveLength(4);
    expect(container.querySelectorAll('.co-find-match-current')).toHaveLength(1);
    typeQuery('one and alpha');
    expect(countText()).toBe(t('editor.find.match_count', { n: 1, total: '1' }));
  });

  it('Enter 下一个 / ⇧Enter 上一个(循环),当前匹配成为选区', async () => {
    const { pm, view } = await mount(DOC);
    openFind(pm);
    typeQuery('alpha');
    const selected = () => view.state.doc.textBetween(view.state.selection.from, view.state.selection.to);
    expect(selected()).toBe('Alpha');
    fireEvent.keyDown(findInput(), { key: 'Enter' });
    expect(countText()).toBe(t('editor.find.match_count', { n: 2, total: '4' }));
    expect(selected()).toBe('alpha');
    fireEvent.keyDown(findInput(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(findInput(), { key: 'Enter', shiftKey: true });
    expect(countText()).toBe(t('editor.find.match_count', { n: 4, total: '4' }));
    expect(selected()).toBe('ALPHA');
  });

  it('选项:区分大小写、全字匹配、正则;无匹配显示「无结果」;空查找词不显示计数', async () => {
    const { pm } = await mount(DOC);
    openFind(pm);
    typeQuery('alpha');
    fireEvent.click(screen.getByRole('button', { name: t('find.option.match_case') }));
    expect(countText()).toBe(t('editor.find.match_count', { n: 1, total: '2' }));
    typeQuery('alph');
    fireEvent.click(screen.getByRole('button', { name: t('find.option.whole_word') }));
    expect(countText()).toBe(t('editor.find.no_results'));
    fireEvent.click(screen.getByRole('button', { name: t('find.option.whole_word') }));
    fireEvent.click(screen.getByRole('button', { name: t('find.option.regex') }));
    typeQuery('(alpha|beta)');
    expect(countText()).toBe(t('editor.find.match_count', { n: 1, total: '3' }));
    typeQuery('');
    expect(countText()).toBe('');
  });

  it('查找条打开时编辑文档 → 匹配与计数重算', async () => {
    const { pm, view, container } = await mount(DOC);
    openFind(pm);
    typeQuery('alpha');
    act(() => view.dispatch(view.state.tr.insertText('alpha ', 1)));
    expect(container.querySelectorAll('.co-find-match')).toHaveLength(5);
    expect(countText()).toContain('5');
  });

  it('Esc 关闭:高亮清除,焦点回编辑区,选区停在当前匹配;已打开时再按 ⌘F 重新聚焦并全选查找词', async () => {
    const { pm, view, container } = await mount(DOC);
    openFind(pm);
    typeQuery('alpha');
    fireEvent.keyDown(findInput(), { key: 'Enter' });
    act(() => pm.focus());
    openFind(pm);
    expect(document.activeElement).toBe(findInput());
    expect(findInput().selectionStart).toBe(0);
    expect(findInput().selectionEnd).toBe(5);
    // 查找条内再按 ⌘F 同样被拦下
    expect(openFind(findInput()).defaultPrevented).toBe(true);
    fireEvent.keyDown(findInput(), { key: 'Escape' });
    expect(queryFindInput()).toBeNull();
    expect(container.querySelectorAll('.co-find-match')).toHaveLength(0);
    expect(document.activeElement).toBe(pm);
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe('alpha');
  });
});

describe('Markdown 预览(只读)模式 ⌘F', () => {
  it('预览区可聚焦;⌘F 打开查找,计数与高亮同编辑模式;不改文档', async () => {
    const { pm, container } = await mount(DOC, true);
    expect(pm.tabIndex).toBe(0);
    expect(pm.getAttribute('contenteditable')).toBe('false');
    const ev = openFind(pm);
    expect(ev.defaultPrevented).toBe(true);
    typeQuery('beta');
    expect(countText()).toBe(t('editor.find.match_count', { n: 1, total: '1' }));
    expect(container.querySelector('.co-find-match-current')?.textContent).toBe('beta');
    expect(mocks.instances.at(-1)!.getMarkdown()).toContain('alpha one and **alpha** two');
  });
});

/** 按键派发到 target(冒泡、可取消),返回事件。 */
function press(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

function select(view: PmView, from: number, to: number) {
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc as never, from, to))));
}

const selectedText = (view: PmView) => view.state.doc.textBetween(view.state.selection.from, view.state.selection.to);

/** 文档里第 n 个(0 起)`word` 的文档位置。 */
function posOf(view: PmView, word: string, n = 0): number {
  const size = view.state.doc.content.size;
  let seen = 0;
  for (let p = 0; p < size; p++) {
    try {
      if (view.state.doc.textBetween(p, p + word.length) === word && seen++ === n) return p;
    } catch {
      /* 越界 */
    }
  }
  throw new Error(`no ${word}`);
}

describe('与代码编辑器查找一致(VSCode findWidget)', () => {
  it('⌘F 把单行选区带入查找框(全选)并查找;多行选区不带入', async () => {
    const { pm, view } = await mount(DOC);
    const at = posOf(view, 'beta');
    select(view, at, at + 4);
    openFind(pm);
    expect(findInput().value).toBe('beta');
    expect(findInput().selectionEnd).toBe(4);
    expect(countText()).toBe(t('editor.find.match_count', { n: 1, total: '1' }));
    fireEvent.keyDown(findInput(), { key: 'Escape' });
    // 跨段落(多行)选区:沿用上次查找词
    select(view, posOf(view, 'one'), at + 2);
    openFind(pm);
    expect(findInput().value).toBe('beta');
  });

  it('正则模式下带入选区时转义正则元字符(VSCode 同)', async () => {
    const { pm, view } = await mount('a.b axb\n');
    openFind(pm);
    fireEvent.click(screen.getByRole('button', { name: t('find.option.regex') }));
    fireEvent.keyDown(findInput(), { key: 'Escape' });
    select(view, 1, 4);
    openFind(pm);
    expect(findInput().value).toBe('a\\.b');
    expect(countText()).toBe(t('editor.find.match_count', { n: 1, total: '1' }));
  });

  it('F3 / ⇧F3(mac 另有 ⌘G / ⇧⌘G)在正文与查找框里都跳下一个 / 上一个;Windows / Linux 的 Ctrl+G 不拦(VSCode 为转到行)', async () => {
    const { pm, view } = await mount(DOC);
    openFind(pm);
    typeQuery('alpha');
    act(() => pm.focus());
    expect(press(pm, { key: 'F3', code: 'F3' }).defaultPrevented).toBe(true);
    expect(countText()).toBe(t('editor.find.match_count', { n: 2, total: '4' }));
    press(findInput(), { key: 'F3', code: 'F3' });
    expect(countText()).toBe(t('editor.find.match_count', { n: 3, total: '4' }));
    press(pm, { key: 'F3', code: 'F3', shiftKey: true });
    expect(countText()).toBe(t('editor.find.match_count', { n: 2, total: '4' }));
    expect(selectedText(view)).toBe('alpha');
    if (detectPlatform() === 'mac') {
      press(pm, { key: 'g', code: 'KeyG', metaKey: true });
      expect(countText()).toBe(t('editor.find.match_count', { n: 3, total: '4' }));
      press(findInput(), { key: 'g', code: 'KeyG', metaKey: true, shiftKey: true });
      expect(countText()).toBe(t('editor.find.match_count', { n: 2, total: '4' }));
    } else {
      expect(press(pm, { key: 'g', code: 'KeyG', ctrlKey: true }).defaultPrevented).toBe(false);
      expect(countText()).toBe(t('editor.find.match_count', { n: 2, total: '4' }));
    }
  });

  it('查找条关闭后 F3:用上次的查找词重新显示查找条(焦点留在正文)并跳到选区之后的下一个', async () => {
    const { pm, view, container } = await mount(DOC);
    openFind(pm);
    typeQuery('alpha');
    fireEvent.keyDown(findInput(), { key: 'Escape' });
    expect(selectedText(view)).toBe('Alpha');
    press(pm, { key: 'F3', code: 'F3' });
    expect(findInput().value).toBe('alpha');
    expect(document.activeElement).toBe(pm);
    expect(countText()).toBe(t('editor.find.match_count', { n: 2, total: '4' }));
    expect(container.querySelectorAll('.co-find-match')).toHaveLength(4);
  });

  it('查找框 ↑ / ↓ 翻历史(与代码编辑器共享 editorFindHistory);回车记入', async () => {
    editorFindHistory.add('beta');
    const { pm } = await mount(DOC);
    openFind(pm);
    typeQuery('alpha');
    fireEvent.keyDown(findInput(), { key: 'Enter' });
    expect(editorFindHistory.entries()).toEqual(['beta', 'alpha']);
    fireEvent.keyDown(findInput(), { key: 'ArrowUp' });
    expect(findInput().value).toBe('beta');
    expect(countText()).toBe(t('editor.find.match_count', { n: 1, total: '1' }));
    fireEvent.keyDown(findInput(), { key: 'ArrowDown' });
    expect(findInput().value).toBe('alpha');
  });

  it('正则非法:计数区显示「正则表达式无效」,title 带错误信息', async () => {
    const { pm, container } = await mount(DOC);
    openFind(pm);
    fireEvent.click(screen.getByRole('button', { name: t('find.option.regex') }));
    typeQuery('alpha(');
    expect(countText()).toBe(t('editor.find.invalid_regex'));
    expect(findInput().getAttribute('aria-invalid')).toBe('true');
    expect(findInput().title).toMatch(/Invalid regular expression/);
    expect(container.querySelectorAll('.co-find-match')).toHaveLength(0);
  });

  it('按 tab 保留查找状态:切走再切回(重挂)查找条、查找词、选项与高亮恢复,焦点不被查找条抢走', async () => {
    const first = await mount(DOC);
    openFind(first.pm);
    fireEvent.click(screen.getByRole('button', { name: t('find.option.match_case') }));
    typeQuery('alpha');
    first.unmount();
    mocks.instances.length = 0;
    const again = await mount(DOC);
    expect(findInput().value).toBe('alpha');
    expect(screen.getByRole('button', { name: t('find.option.match_case') }).getAttribute('aria-pressed')).toBe('true');
    expect(again.container.querySelectorAll('.co-find-match')).toHaveLength(2);
    expect(document.activeElement).not.toBe(findInput());
    // 关闭后切回:查找条不再出现
    fireEvent.keyDown(findInput(), { key: 'Escape' });
    again.unmount();
    mocks.instances.length = 0;
    await mount(DOC);
    expect(queryFindInput()).toBeNull();
  });

  it('按 tab 区分;tab 关闭后卸载即丢弃,重新打开不恢复', async () => {
    const a = await mount(DOC);
    openFind(a.pm);
    typeQuery('alpha');
    a.unmount();
    mocks.instances.length = 0;
    const b = await mount(DOC, false, '/w/b.md');
    expect(queryFindInput()).toBeNull();
    b.unmount();
    mocks.instances.length = 0;
    const reopened = await mount(DOC);
    expect(findInput().value).toBe('alpha');
    // 关闭 tab(先从 store 移除,随后视图卸载)
    useEditorStore.setState({ tabs: [createTab('/w/b.md', '')] });
    reopened.unmount();
    mocks.instances.length = 0;
    useEditorStore.setState({ tabs: [createTab('/w/a.md', ''), createTab('/w/b.md', '')] });
    await mount(DOC);
    expect(queryFindInput()).toBeNull();
  });
});
