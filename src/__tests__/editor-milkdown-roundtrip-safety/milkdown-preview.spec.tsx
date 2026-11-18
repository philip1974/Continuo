// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';

// 编辑器当前文档 = { md }(不可变,改内容换新对象);mount(md) 模拟挂载完成,
// edit(md) 模拟输入后 plugin-listener 防抖到点触发 updated。
const milkdownHarness = vi.hoisted(() => ({
  doc: { md: '' },
  mounted: [] as Array<(ctx: unknown) => void>,
  updated: [] as Array<(ctx: unknown, doc: unknown, prev: unknown) => void>,
  setReadonly: vi.fn(),
  reset() {
    this.doc = { md: '' };
    this.mounted = [];
    this.updated = [];
    this.setReadonly.mockClear();
  },
  mount(markdown: string) {
    this.doc = { md: markdown };
    for (const cb of this.mounted) cb({});
  },
  edit(markdown: string) {
    this.doc = { md: markdown };
    for (const cb of this.updated) cb({}, this.doc, null);
  },
}));

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
    setReadonly: milkdownHarness.setReadonly,
    on: (
      register: (listener: {
        mounted: (cb: (_ctx: unknown) => void) => void;
        updated: (cb: (_ctx: unknown, doc: unknown, prev: unknown) => void) => void;
      }) => void,
    ) => {
      register({
        mounted: (cb) => {
          milkdownHarness.mounted.push(cb);
        },
        updated: (cb) => {
          milkdownHarness.updated.push(cb);
        },
      });
    },
    editor: {
      ctx: {
        get: (name: string) => {
          if (name === 'editorView') return { state: { doc: milkdownHarness.doc } };
          if (name === 'serializer') return (doc: { md: string }) => doc.md;
          throw new Error(`no slice ${name}`);
        },
      },
    },
  })),
}));

vi.mock('@milkdown/react', () => ({
  Milkdown: () => <div data-testid="milkdown" />,
  MilkdownProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useEditor: (init: (root: HTMLElement) => unknown) => {
    init(document.createElement('div'));
  },
}));

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

beforeEach(() => {
  milkdownHarness.reset();
});

afterEach(() => {
  cleanup();
});

describe('MilkdownEditor preview emissions', () => {
  it('does not call onChange for mount or later markdownUpdated emissions in preview mode', () => {
    const onChange = vi.fn();
    render(<MilkdownEditor tabId="/t.md" defaultValue="# Title" readonly onChange={onChange} />);

    milkdownHarness.mount('# serialized mount');
    milkdownHarness.edit('# serialized later');

    expect(milkdownHarness.setReadonly).toHaveBeenCalledWith(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('MilkdownEditor edit emissions', () => {
  it('forwards the very first real edit', () => {
    const onChange = vi.fn();
    render(<MilkdownEditor tabId="/t.md" defaultValue={'# Title\n'} onChange={onChange} />);

    milkdownHarness.mount('# Title\n');
    milkdownHarness.edit('# Titlex\n');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('# Titlex\n');
  });

  it('ignores the mount-time trailing-paragraph normalization, then forwards edits', () => {
    const onChange = vi.fn();
    const doc = '# Title\n\n```mermaid\ngraph TD\n```\n';
    render(<MilkdownEditor tabId="/t.md" defaultValue={doc} onChange={onChange} />);

    milkdownHarness.mount(doc);
    milkdownHarness.edit(`${doc}\n`);
    expect(onChange).not.toHaveBeenCalled();

    milkdownHarness.edit(`# Titlex\n\n\`\`\`mermaid\ngraph TD\n\`\`\`\n\n`);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
