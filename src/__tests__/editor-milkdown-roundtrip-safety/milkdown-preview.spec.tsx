// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';

const milkdownHarness = vi.hoisted(() => ({
  markdownUpdated: null as
    | null
    | ((_ctx: unknown, markdown: string, prevMarkdown: string) => void),
  setReadonly: vi.fn(),
  reset() {
    this.markdownUpdated = null;
    this.setReadonly.mockClear();
  },
  emit(markdown: string, prevMarkdown: string) {
    this.markdownUpdated?.({}, markdown, prevMarkdown);
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
        markdownUpdated: (
          cb: (_ctx: unknown, markdown: string, prevMarkdown: string) => void,
        ) => void;
      }) => void,
    ) => {
      register({
        markdownUpdated: (cb) => {
          milkdownHarness.markdownUpdated = cb;
        },
      });
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
    render(<MilkdownEditor defaultValue="# Title" readonly onChange={onChange} />);

    milkdownHarness.emit('# serialized mount', '# Title');
    milkdownHarness.emit('# serialized later', '# serialized mount');

    expect(milkdownHarness.setReadonly).toHaveBeenCalledWith(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('MilkdownEditor edit emissions', () => {
  it('forwards the very first real edit', () => {
    const onChange = vi.fn();
    render(<MilkdownEditor defaultValue={'# Title\n'} onChange={onChange} />);

    milkdownHarness.emit('# Titlex\n', '# Title\n');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('# Titlex\n');
  });

  it('ignores the mount-time trailing-paragraph normalization, then forwards edits', () => {
    const onChange = vi.fn();
    const doc = '# Title\n\n```mermaid\ngraph TD\n```\n';
    render(<MilkdownEditor defaultValue={doc} onChange={onChange} />);

    milkdownHarness.emit(`${doc}\n`, doc);
    expect(onChange).not.toHaveBeenCalled();

    milkdownHarness.emit(`# Titlex\n\n\`\`\`mermaid\ngraph TD\n\`\`\`\n\n`, `${doc}\n`);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
