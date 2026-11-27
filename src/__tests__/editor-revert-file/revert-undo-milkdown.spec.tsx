// @vitest-environment jsdom
// 真实 Crepe(不 mock):还原文件 / 外部修改重载(reloadEpoch 递增)时磁盘内容以**可撤销**的一步就地套进 Markdown 编辑视图 ——
// 不重挂载(焦点 / 光标保留),⌘Z 找回重载前的内容(VSCode ModelService.updateModel:前后 pushStackElement 的最小差异编辑);
// 这一步自成一个撤销组:不与之前的输入合并,之后的输入也不并进来;套用后不上抛(保存的源码与磁盘一致、不变脏)。
// BDD: 见同目录 README.md。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { redo, undo } from '@milkdown/kit/prose/history';
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

const ui = (value: string, epoch: number, onChange: (md: string) => void) => (
  <MilkdownEditor tabId="/n.md" defaultValue={value} value={value} reloadEpoch={epoch} onChange={onChange} />
);

function typeAfter(view: PmView, anchor: string, text: string): void {
  const end = posAfter(view, anchor);
  const Sel = view.state.selection.constructor;
  view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, end)));
  view.dispatch(view.state.tr.insertText(text, end));
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });

describe('还原 / 外部重载(reloadEpoch)→ Milkdown 就地可撤销地套用(真实 Crepe)', () => {
  it('不重挂载;⌘Z 找回还原前的输入(并上抛,tab 变脏);⇧⌘Z 回到磁盘版本;套用本身不上抛', async () => {
    const disk = '# Title\n\nbody\n';
    const onChange = vi.fn();
    const { rerender } = render(ui(disk, 0, onChange));
    const crepe = await waitMounted();
    const view = viewOf(crepe);

    typeAfter(view, 'body', 'A');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const mine = onChange.mock.calls[0]![0] as string;
    rerender(ui(mine, 0, onChange));

    // 还原:store 换回磁盘内容、epoch + 1
    await act(async () => {
      rerender(ui(disk, 1, onChange));
    });
    expect(instances).toHaveLength(1);
    expect(viewOf(crepe)).toBe(view);
    expect(crepe.getMarkdown()).not.toContain('bodyA');
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1); // 套用不上抛:保存的仍是磁盘内容

    undo(view.state as never, view.dispatch as never);
    expect(crepe.getMarkdown()).toContain('bodyA');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(onChange.mock.calls[1]![0]).toBe(mine);

    redo(view.state as never, view.dispatch as never);
    expect(crepe.getMarkdown()).not.toContain('bodyA');
  });

  it('紧接着输入就还原:撤销只撤还原这一步(不连带之前的输入);还原后马上输入,撤销也只撤新输入', async () => {
    const disk = '# Title\n\nbody\n';
    const onChange = vi.fn();
    const { rerender } = render(ui(disk, 0, onChange));
    const crepe = await waitMounted();
    const view = viewOf(crepe);

    typeAfter(view, 'body', 'A');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 3000 });
    rerender(ui(onChange.mock.calls[0]![0] as string, 0, onChange));
    // 同一撤销组时限(500ms)内还原
    await act(async () => {
      rerender(ui(disk, 1, onChange));
    });
    typeAfter(view, 'body', 'B');
    expect(crepe.getMarkdown()).toContain('bodyB');

    undo(view.state as never, view.dispatch as never); // 撤 B
    expect(crepe.getMarkdown()).toContain('body\n');
    expect(crepe.getMarkdown()).not.toMatch(/bodyA|bodyB/);
    undo(view.state as never, view.dispatch as never); // 撤还原
    expect(crepe.getMarkdown()).toContain('bodyA');
    undo(view.state as never, view.dispatch as never); // 撤 A
    expect(crepe.getMarkdown()).not.toMatch(/bodyA/);
  });

  it('epoch 不变的内容变化(另一编辑器组)仍不进撤销栈', async () => {
    const onChange = vi.fn();
    const { rerender } = render(ui('# T\n\nbody\n', 0, onChange));
    const crepe = await waitMounted();
    const view = viewOf(crepe);
    await act(async () => {
      rerender(ui('# T\n\nbody more\n', 0, onChange));
    });
    expect(crepe.getMarkdown()).toContain('body more');
    expect(undo(view.state as never, view.dispatch as never)).toBe(false);
  });
});
