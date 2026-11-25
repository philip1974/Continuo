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
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  mocks.instances.length = 0;
});

interface PmView {
  readonly state: {
    readonly doc: { textBetween(from: number, to: number): string; readonly content: { readonly size: number } };
    readonly selection: { readonly from: number; readonly to: number };
    readonly tr: { insertText(text: string, from: number, to?: number): unknown };
  };
  dispatch(tr: unknown): void;
}

async function mount(markdown: string, readonly = false) {
  const utils = render(<MilkdownEditor tabId="/w/a.md" fileName="/w/a.md" defaultValue={markdown} readonly={readonly} />);
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

const findInput = () => screen.getByRole('textbox', { name: t('panels.terminal.search.placeholder') }) as HTMLInputElement;
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
    fireEvent.click(screen.getByRole('button', { name: t('panels.terminal.search.case_sensitive') }));
    expect(countText()).toBe(t('editor.find.match_count', { n: 1, total: '2' }));
    typeQuery('alph');
    fireEvent.click(screen.getByRole('button', { name: t('panels.terminal.search.whole_word') }));
    expect(countText()).toBe(t('editor.find.no_results'));
    fireEvent.click(screen.getByRole('button', { name: t('panels.terminal.search.whole_word') }));
    fireEvent.click(screen.getByRole('button', { name: t('panels.terminal.search.regex') }));
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
    expect(screen.queryByRole('textbox', { name: t('panels.terminal.search.placeholder') })).toBeNull();
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
