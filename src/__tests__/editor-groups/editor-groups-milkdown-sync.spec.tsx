// @vitest-environment jsdom
// 真实 Crepe(不 mock):同一 Markdown 在两个编辑器组都用富文本编辑时,另一组的编辑以增量事务套进本组视图 ——
// 不重挂载,本组光标 / 选区随变化映射(VSCode:各编辑器保留自己的光标,别处编辑映射到本地位置),
// 本组撤销栈保留(只撤销本组自己的输入),套用的外部内容不再上抛。BDD: 见同目录 README.md「共享文档方案」。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { undo, undoDepth } from '@milkdown/kit/prose/history';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';

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

interface PmState {
  doc: { content: { size: number }; textContent: string };
  selection: { head: number; constructor: { create: (doc: object, pos: number) => unknown } };
  tr: { insertText: (text: string, pos: number) => unknown; setSelection: (s: unknown) => unknown };
}
interface PmView {
  state: PmState;
  dispatch: (tr: unknown) => void;
}

function viewOf(crepe: CrepeType): PmView {
  return crepe.editor.ctx.get<PmView, 'editorView'>('editorView');
}

async function waitMounted(): Promise<CrepeType> {
  for (let i = 0; i < 100; i++) {
    const crepe = instances.at(-1);
    if (crepe) {
      try {
        if (viewOf(crepe).state) {
          await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
          });
          return crepe;
        }
      } catch {
        /* 尚未就绪 */
      }
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error('Crepe 未挂载');
}

/** 文档里 `text` 之后的位置(只在文本节点里找)。 */
function posAfter(view: PmView, text: string): number {
  let found = -1;
  (view.state.doc as unknown as {
    descendants: (f: (n: { isText: boolean; text?: string }, pos: number) => boolean | void) => void;
  }).descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.isText && n.text) {
      const i = n.text.indexOf(text);
      if (i >= 0) found = pos + i + text.length;
    }
  });
  if (found < 0) throw new Error(`no text ${text}`);
  return found;
}

afterEach(() => {
  cleanup();
  instances.length = 0;
});

describe('另一组编辑同一 Markdown → 本组 Milkdown 增量套用(真实 Crepe)', () => {
  it('不重挂载;本组光标随前面的插入后移;撤销只撤本组输入;套用内容不再上抛', async () => {
    const initial = '# Title\n\nbody\n';
    const onChange = vi.fn();
    const ui = (value: string) => (
      <MilkdownEditor tabId="/n.md" defaultValue={value} value={value} onChange={onChange} />
    );
    const { rerender } = render(ui(initial));
    const crepe = await waitMounted();
    const view = viewOf(crepe);

    // 本组:段落末尾输入 A(进撤销栈),上抛到 store
    const end = posAfter(view, 'body');
    const Sel = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, end)));
    view.dispatch(view.state.tr.insertText('A', end));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const mine = onChange.mock.calls[0]![0] as string;
    expect(mine).toContain('bodyA');
    rerender(ui(mine)); // store 回流自己上抛的内容:不动视图
    const headAfterA = view.state.selection.head;
    expect(headAfterA).toBe(end + 1);

    // 另一组:标题里输入 R → store 内容变了
    const theirs = mine.replace('# Title', '# TitleR');
    await act(async () => {
      rerender(ui(theirs));
    });
    expect(instances).toHaveLength(1); // 未重挂载
    const same = viewOf(crepe);
    expect(same).toBe(view);
    expect(crepe.getMarkdown()).toContain('# TitleR');
    expect(crepe.getMarkdown()).toContain('bodyA');
    // 光标仍在 A 之后(随标题里多出的一个字符后移)
    expect(view.state.selection.head).toBe(headAfterA + 1);

    // 套用的外部内容不回抛
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(onChange).toHaveBeenCalledTimes(1);

    // 撤销栈保留,撤销只撤本组的 A,不撤另一组的 R
    expect(undoDepth(view.state as never)).toBeGreaterThan(0);
    undo(view.state as never, view.dispatch as never);
    expect(crepe.getMarkdown()).toContain('# TitleR');
    expect(crepe.getMarkdown()).not.toContain('bodyA');
  });

  it('只读预览同样增量套用,不重挂载', async () => {
    const ui = (value: string) => <MilkdownEditor tabId="/p.md" defaultValue={value} value={value} readonly />;
    const { rerender } = render(ui('# Title\n\nbody\n'));
    const crepe = await waitMounted();
    await act(async () => {
      rerender(ui('# Title\n\nbody more\n'));
    });
    expect(instances).toHaveLength(1);
    expect(crepe.getMarkdown()).toContain('body more');
  });
});
