// @vitest-environment jsdom
// Milkdown 防抖窗口内的输入在关窗 / 卸载时同步回写 store(见同目录 README.md)。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import {
  applyEditorWriteBack,
  flushEditorWriteBacks,
} from '../../panels/Editor/editor-writeback-registry';
import { useAutoSave } from '../../panels/Editor/useAutoSave';
import {
  flushPendingAutoSave,
  registerAutoSaveFlush,
} from '../../panels/Editor/autosave-flush-registry';
import { createTab, useEditorStore } from '../../stores/editor.store';

type MdListener = (ctx: unknown, markdown: string, prev: string) => void;

// 模拟 Crepe:编辑器当前文档 = crepeHarness.doc(不可变对象,改内容即换新对象,同 ProseMirror);
// serializer / getMarkdown 返回其 markdown(含尚未经 200ms 防抖上抛的输入);serialize 是 spy,
// 用来断言「文档未变不序列化」。listener 的 mounted / markdownUpdated 由测试手动触发。
type FakeDoc = { md: string };
const crepeHarness = vi.hoisted(() => {
  const h = {
    doc: { md: '' } as { md: string },
    serialize: null as unknown as ReturnType<typeof vi.fn>,
    mounted: [] as Array<(ctx: unknown) => void>,
    docUpdated: [] as Array<(ctx: unknown, doc: unknown, prev: unknown) => void>,
    updated: [] as Array<(ctx: unknown, markdown: string, prev: string) => void>,
    get markdown(): string {
      return h.doc.md;
    },
    set markdown(md: string) {
      h.doc = { md };
    },
  };
  return h;
});

vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: {
    CodeMirror: 'CodeMirror',
    ListItem: 'ListItem',
    LinkTooltip: 'LinkTooltip',
    Cursor: 'Cursor',
    ImageBlock: 'ImageBlock',
    BlockEdit: 'BlockEdit',
    Toolbar: 'Toolbar',
    Placeholder: 'Placeholder',
    Table: 'Table',
    Latex: 'Latex',
  },
  Crepe: vi.fn().mockImplementation(() => ({
    setReadonly: vi.fn(),
    on: (fn: (l: unknown) => void) => {
      fn({
        mounted: (cb: (ctx: unknown) => void) => crepeHarness.mounted.push(cb),
        updated: (cb: (ctx: unknown, doc: unknown, prev: unknown) => void) =>
          crepeHarness.docUpdated.push(cb),
        markdownUpdated: (cb: MdListener) => crepeHarness.updated.push(cb),
      });
    },
    editor: {
      ctx: {
        get: (name: string) => {
          if (name === 'editorView') return { state: { doc: crepeHarness.doc } };
          if (name === 'serializer') return crepeHarness.serialize;
          throw new Error(`no slice ${name}`);
        },
      },
    },
    getMarkdown: () => crepeHarness.serialize(crepeHarness.doc),
    create: async () => ({}),
    destroy: async () => {},
  })),
}));

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountEditor(
  props: Partial<React.ComponentProps<typeof MilkdownEditor>> = {},
) {
  const onChange = vi.fn();
  const onWriteBack = vi.fn();
  const utils = render(
    <MilkdownEditor
      defaultValue="hello"
      onChange={onChange}
      onWriteBack={onWriteBack}
      {...props}
    />,
  );
  await settle();
  // 挂载完成:编辑器序列化结果 = 初始内容
  crepeHarness.markdown = 'hello\n';
  for (const cb of crepeHarness.mounted) cb({});
  return { ...utils, onChange, onWriteBack };
}

beforeEach(() => {
  crepeHarness.markdown = '';
  crepeHarness.serialize = vi.fn((doc: FakeDoc) => doc.md);
  crepeHarness.mounted.length = 0;
  crepeHarness.docUpdated.length = 0;
  crepeHarness.updated.length = 0;
});
afterEach(() => cleanup());

describe('Milkdown 同步回写', () => {
  it('防抖窗口内触发关窗 flush → 同步把编辑器最新全文回写(带上抛基线)', async () => {
    const { onWriteBack, onChange } = await mountEditor();
    crepeHarness.markdown = 'hello world\n'; // 用户刚输入,200ms 防抖尚未触发

    flushEditorWriteBacks();

    expect(onWriteBack).toHaveBeenCalledTimes(1);
    expect(onWriteBack).toHaveBeenCalledWith('hello world\n', 'hello');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('基线随上抛推进:已上抛的编辑后再输入 → 基线为最近上抛内容', async () => {
    const { onWriteBack, onChange } = await mountEditor();
    crepeHarness.markdown = 'a\n';
    for (const cb of crepeHarness.docUpdated) cb({}, crepeHarness.doc, null);
    for (const cb of crepeHarness.updated) cb({}, 'a\n', 'hello\n');
    expect(onChange).toHaveBeenCalledWith('a\n');
    crepeHarness.markdown = 'ab\n';

    flushEditorWriteBacks();
    expect(onWriteBack).toHaveBeenCalledWith('ab\n', 'a\n');
  });

  it('没有待上抛的编辑(仅尾部空白差异 / 已上抛)→ 不回写', async () => {
    const { onWriteBack } = await mountEditor();
    crepeHarness.markdown = 'hello\n\n'; // 挂载期补尾随空段落
    flushEditorWriteBacks();
    expect(onWriteBack).not.toHaveBeenCalled();
  });

  it('只读预览 → 不回写', async () => {
    const { onWriteBack } = await mountEditor({ readonly: true });
    crepeHarness.markdown = 'changed\n';
    flushEditorWriteBacks();
    expect(onWriteBack).not.toHaveBeenCalled();
  });

  it('卸载(切 tab / 切 mode)→ 同步回写一次;之后迟到的防抖 emit 不再上抛,flush 也不再调用', async () => {
    const { onWriteBack, onChange, unmount } = await mountEditor();
    crepeHarness.markdown = 'typed\n';

    unmount();
    expect(onWriteBack).toHaveBeenCalledTimes(1);
    expect(onWriteBack).toHaveBeenCalledWith('typed\n', 'hello');

    // 200ms 后 lodash debounce 照常触发(销毁不取消)
    for (const cb of crepeHarness.docUpdated) cb({}, crepeHarness.doc, null);
    for (const cb of crepeHarness.updated) cb({}, 'typed\n', 'hello\n');
    expect(onChange).not.toHaveBeenCalled();
    flushEditorWriteBacks();
    expect(onWriteBack).toHaveBeenCalledTimes(1);
  });
});

describe('Milkdown 回写不做多余的全量序列化(大文档每次约 70ms)', () => {
  it('挂载不序列化;文档未变时关窗 / Cmd+S 的 flush 不序列化', async () => {
    const { onWriteBack } = await mountEditor();
    expect(crepeHarness.serialize).not.toHaveBeenCalled();

    flushEditorWriteBacks();
    flushEditorWriteBacks();
    expect(crepeHarness.serialize).not.toHaveBeenCalled();
    expect(onWriteBack).not.toHaveBeenCalled();
  });

  it('只读预览挂载 / flush / 卸载都不序列化', async () => {
    const { unmount } = await mountEditor({ readonly: true });
    flushEditorWriteBacks();
    unmount();
    expect(crepeHarness.serialize).not.toHaveBeenCalled();
  });

  it('挂载后无编辑直接卸载 → 不序列化、不回写', async () => {
    const { onWriteBack, unmount } = await mountEditor();
    unmount();
    expect(crepeHarness.serialize).not.toHaveBeenCalled();
    expect(onWriteBack).not.toHaveBeenCalled();
  });

  it('有编辑时基线按挂载时的文档惰性序列化;回写后文档未再变 → 下次 flush 不再序列化', async () => {
    const { onWriteBack } = await mountEditor();
    const mountDoc = crepeHarness.doc;
    crepeHarness.markdown = 'hello world\n';
    const editedDoc = crepeHarness.doc;

    flushEditorWriteBacks();
    expect(crepeHarness.serialize.mock.calls.map((c) => c[0])).toEqual([mountDoc, editedDoc]);
    expect(onWriteBack).toHaveBeenCalledWith('hello world\n', 'hello');

    crepeHarness.serialize.mockClear();
    flushEditorWriteBacks();
    expect(crepeHarness.serialize).not.toHaveBeenCalled();
    expect(onWriteBack).toHaveBeenCalledTimes(1);
  });
});

describe('applyEditorWriteBack', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
  });

  it('store 内容仍是基线 → 写入并变脏', () => {
    useEditorStore.getState().openTab(createTab('/a.md', 'hello'));
    applyEditorWriteBack(useEditorStore, '/a.md', 'hello world', 'hello');
    const t = useEditorStore.getState().tabs[0]!;
    expect(t.content).toBe('hello world');
    expect(t.dirty).toBe(true);
  });

  it('store 已被外部重载改过(≠ 基线)→ 不用旧编辑器内容覆盖', () => {
    useEditorStore.getState().openTab(createTab('/a.md', 'hello'));
    useEditorStore.getState().reloadFromDisk('/a.md', 'external');
    applyEditorWriteBack(useEditorStore, '/a.md', 'hello world', 'hello');
    expect(useEditorStore.getState().tabs[0]!.content).toBe('external');
  });
});

describe('关窗 autosave flush 覆盖回写产生的未排队编辑', () => {
  function Probe({ saveTab }: { saveTab: (id: string) => Promise<unknown> }) {
    useAutoSave(saveTab, { enabled: true, delayMs: 2000 });
    return null;
  }

  beforeEach(() => {
    registerAutoSaveFlush(null);
    useEditorStore.setState({ tabs: [], activeTabId: null });
  });
  afterEach(() => registerAutoSaveFlush(null));

  it('原本干净的 tab 被同步回写变脏(React 尚未重渲排队)→ flushPendingAutoSave 仍落盘', async () => {
    useEditorStore.getState().openTab(createTab('/a.md', 'hello'));
    const saveTab = vi.fn(async () => ({ ok: true }));
    render(<Probe saveTab={saveTab} />);
    await settle();

    // 关窗握手:同步回写后立刻 flush,中间没有 React 渲染 / effect 机会
    applyEditorWriteBack(useEditorStore, '/a.md', 'hello world', 'hello');
    await flushPendingAutoSave();

    expect(saveTab).toHaveBeenCalledWith('/a.md');
  });

  it('autosave 失败后未再编辑(内容已被 effect 看过)→ 关窗 flush 不重试', async () => {
    useEditorStore.getState().openTab(createTab('/a.md', 'hello'));
    act(() => useEditorStore.getState().updateContent('/a.md', 'edited'));
    const saveTab = vi.fn(async () => ({ ok: false, code: 'X', message: 'x' }));
    render(<Probe saveTab={saveTab} />);
    await settle();
    await act(async () => {
      await flushPendingAutoSave(); // 首次落盘(失败)
    });
    saveTab.mockClear();

    await flushPendingAutoSave();
    expect(saveTab).not.toHaveBeenCalled();
  });
});
