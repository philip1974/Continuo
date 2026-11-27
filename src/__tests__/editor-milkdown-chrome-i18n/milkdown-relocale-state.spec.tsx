// @vitest-environment jsdom
// BDD:运行中切换界面语言,Markdown 编辑模式(真实 Crepe)以当前内容重挂(Crepe 无运行时更新文案的接口),
// 重挂后还原选区与焦点;查找条不随之重挂(查找框焦点与输入保留)。见同目录 README「切换语言」。
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { markdownFindOf } from '../../panels/Editor/markdown-find-registry';
import { markdownFindResult } from '../../panels/Editor/markdown-find';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { clearEditorViewStates } from '../../panels/Editor/editor-view-state-cache';
import { getLocale, notifyLocaleChange, setLocale, type Locale } from '../../i18n';
import { PRIMARY_EDITOR_GROUP_ID } from '../../../electron/shared/editor-group-id';

const instances = vi.hoisted(() => [] as CrepeType[]);

vi.mock('@milkdown/crepe', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@milkdown/crepe')>();
  class RecordingCrepe extends mod.Crepe {
    constructor(...args: ConstructorParameters<typeof mod.Crepe>) {
      super(...args);
      instances.push(this);
    }
  }
  return { ...mod, Crepe: RecordingCrepe };
});

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

const TAB = '/w/relocale.md';
const DOC = ['# Title', '', 'Para one has words', '', '- a', '- b', '', 'End', ''].join('\n');

async function waitCrepe(count: number): Promise<EditorView> {
  for (let i = 0; i < 200; i++) {
    const crepe = instances[count - 1];
    try {
      const view = crepe?.editor.ctx.get<EditorView, 'editorView'>('editorView');
      if (crepe && view?.state && view.dom.isConnected && view.dom.hasAttribute('aria-label')) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
        return view;
      }
    } catch {
      /* 尚未就绪 */
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`第 ${count} 个 Crepe 未挂载`);
}

const nextFrames = () =>
  act(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

function switchLocale(locale: Locale): void {
  act(() => {
    setLocale(locale);
    notifyLocaleChange();
  });
}

/** 「Para one has words」里 one 的范围(ProseMirror 位置)。 */
function rangeOf(view: EditorView, word: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return;
    const i = node.text!.indexOf(word);
    if (i >= 0) found = { from: pos + i, to: pos + i + word.length };
  });
  if (!found) throw new Error(`no ${word}`);
  return found;
}

let original: Locale;
beforeEach(() => {
  original = getLocale();
  switchLocale('en');
  clearEditorViewStates();
  useEditorStore.setState({ tabs: [createTab(TAB, DOC)], activeTabId: TAB });
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  instances.length = 0;
  switchLocale(original);
});

describe('切换界面语言后 Markdown 编辑区的状态', () => {
  it('重挂后选区(含反向选择)与焦点还原到切换前', async () => {
    render(<MilkdownEditor tabId={TAB} fileName={TAB} defaultValue={DOC} />);
    const before = await waitCrepe(1);
    await nextFrames();
    const { from, to } = rangeOf(before, 'one');
    act(() => {
      before.dispatch(before.state.tr.setSelection(TextSelection.create(before.state.doc, to, from)));
      before.focus();
    });
    expect(before.dom.contains(document.activeElement)).toBe(true);

    switchLocale('zh');
    const after = await waitCrepe(2);
    await nextFrames();
    expect(after).not.toBe(before);
    expect(after.state.selection.anchor).toBe(to);
    expect(after.state.selection.head).toBe(from);
    expect(after.dom.contains(document.activeElement)).toBe(true);
  });

  it('切换前焦点不在编辑区:重挂后不抢焦点(选区照样还原)', async () => {
    render(
      <>
        <button type="button">outside</button>
        <MilkdownEditor tabId={TAB} fileName={TAB} defaultValue={DOC} />
      </>,
    );
    const before = await waitCrepe(1);
    await nextFrames();
    const { from } = rangeOf(before, 'words');
    act(() => {
      before.dispatch(before.state.tr.setSelection(TextSelection.create(before.state.doc, from)));
    });
    const outside = document.querySelector('button')!;
    act(() => outside.focus());

    switchLocale('ko');
    const after = await waitCrepe(2);
    await nextFrames();
    expect(after.state.selection.head).toBe(from);
    expect(document.activeElement).toBe(outside);
  });

  it('查找条不随之重挂:查找框仍是同一个元素、焦点与查找词保留', async () => {
    render(<MilkdownEditor tabId={TAB} fileName={TAB} defaultValue={DOC} />);
    await waitCrepe(1);
    act(() => markdownFindOf(TAB, PRIMARY_EDITOR_GROUP_ID)!.open());
    const input = document.activeElement as HTMLInputElement;
    expect(input.placeholder).toBe('Find');
    fireEvent.change(input, { target: { value: 'one' } });

    switchLocale('zh');
    await waitCrepe(2);
    await nextFrames();
    expect(input.isConnected).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('one');
  });

  it('查找条开着:重挂后当前匹配(计数 / 高亮)与切换前一致,下一次「查找下一个」从它接着走', async () => {
    render(<MilkdownEditor tabId={TAB} fileName={TAB} defaultValue={DOC} />);
    const before = await waitCrepe(1);
    await nextFrames();
    const find = () => markdownFindOf(TAB, PRIMARY_EDITOR_GROUP_ID)!;
    act(() => find().open());
    const input = document.activeElement as HTMLInputElement;
    // 「a」:Para 两个、has、列表项 a → 4 个匹配
    fireEvent.change(input, { target: { value: 'a' } });
    act(() => find().step(1));
    act(() => find().step(1));
    expect(markdownFindResult(before.state)).toEqual({ count: 4, index: 2 });
    const status = () => document.querySelector('[role="status"]')!.textContent;
    expect(status()).toMatch(/3\D+4/);

    switchLocale('zh');
    const after = await waitCrepe(2);
    await nextFrames();
    expect(markdownFindResult(after.state)).toEqual({ count: 4, index: 2 });
    expect(after.dom.querySelectorAll('.co-find-match-current')).toHaveLength(1);
    expect(status()).toMatch(/3\D+4/);
    act(() => find().step(1));
    expect(markdownFindResult(after.state).index).toBe(3);
  });
});
