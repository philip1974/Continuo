// @vitest-environment jsdom
// 真实 Crepe(不 mock):钉住 MilkdownEditor 依赖的 Milkdown 内部契约(见同目录 README.md)——
//   - 按 slice 名 'editorView' / 'serializer' 取得编辑器视图与序列化器(@milkdown/kit 非直接依赖);
//   - ProseMirror 文档不可变:不改文档的事务(移动选区)保持引用,改文档换新对象;
//   - React 卸载顺序下,卸载回写时编辑器仍可取全文。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Crepe as CrepeType } from '@milkdown/crepe';
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

interface PmView {
  state: {
    doc: object;
    tr: { insertText: (text: string, pos: number) => unknown; setSelection: (s: unknown) => unknown };
    selection: { constructor: { atEnd: (doc: object) => unknown } };
  };
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
        // editorView slice 初值是空对象,视图就绪后才有 state;再让出一拍给 listener.mounted
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

afterEach(() => {
  cleanup();
  instances.length = 0;
});

describe('Milkdown 内部契约(真实 Crepe)', () => {
  it('slice 名可取视图与序列化器,序列化结果与 getMarkdown 一致;选区事务不换文档,输入换文档', async () => {
    render(<MilkdownEditor tabId="/t.md" defaultValue={'# Title\n\nbody\n'} />);
    const crepe = await waitMounted();
    const view = viewOf(crepe);
    const serialize = crepe.editor.ctx.get<(doc: object) => string, 'serializer'>('serializer');
    expect(serialize(view.state.doc)).toBe(crepe.getMarkdown());

    const before = view.state.doc;
    const Sel = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Sel.atEnd(view.state.doc)));
    expect(view.state.doc).toBe(before);

    view.dispatch(view.state.tr.insertText('x', 3));
    expect(view.state.doc).not.toBe(before);
  });

  it('输入后防抖未到即卸载 → 卸载回写拿到含新输入的全文', async () => {
    const onWriteBack = vi.fn();
    const { unmount } = render(
      <MilkdownEditor tabId="/t.md" defaultValue={'# Title\n\nbody\n'} onWriteBack={onWriteBack} />,
    );
    const crepe = await waitMounted();
    const view = viewOf(crepe);
    view.dispatch(view.state.tr.insertText('X', 3));

    unmount();
    expect(onWriteBack).toHaveBeenCalledTimes(1);
    expect(onWriteBack.mock.calls[0]![0]).toContain('TiXtle');
    expect(onWriteBack.mock.calls[0]![1]).toBe('# Title\n\nbody\n');
  });

  it('真实 plugin-listener updated:小文档输入后约 200ms 上抛全文', async () => {
    const onChange = vi.fn();
    render(<MilkdownEditor tabId="/t.md" defaultValue={'# Title\n\nbody\n'} onChange={onChange} />);
    const crepe = await waitMounted();
    const view = viewOf(crepe);
    view.dispatch(view.state.tr.insertText('X', 3));
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toContain('TiXtle');
  });
});
