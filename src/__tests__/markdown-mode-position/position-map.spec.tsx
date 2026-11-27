// @vitest-environment jsdom
// BDD:Markdown 源码行 ↔ Milkdown 文档位置映射(见同目录 README「映射」)。真实 Crepe:用它的 remark 处理器(slice
// 'remark')解析同一份 markdown,与它建出的 ProseMirror 文档同步下钻;钉住各类块两边能对上。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import {
  locateSourceLine,
  parseMarkdownTree,
  posForSourceLine,
  sourceLineAtPos,
  type PmNode,
  type RemarkLike,
} from '../../panels/Editor/markdown-position-map';

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

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  instances.length = 0;
});

const DOC = [
  '# Title', // 1
  '', // 2
  'Intro paragraph', // 3
  'spanning two lines', // 4
  '', // 5
  '- item one', // 6
  '- item two', // 7
  '  continued', // 8
  '- item three', // 9
  '', // 10
  '> quote line', // 11
  '', // 12
  '```js', // 13
  'const a = 1;', // 14
  'const b = 2;', // 15
  '```', // 16
  '', // 17
  '| h1 | h2 |', // 18
  '| -- | -- |', // 19
  '| c1 | c2 |', // 20
  '| c3 | c4 |', // 21
  '', // 22
  '[ref]: https://example.com', // 23(链接引用定义:Milkdown 不建节点)
  '', // 24
  'Last para', // 25
  '',
].join('\n');

async function mounted(): Promise<{ doc: PmNode; remark: RemarkLike }> {
  render(<MilkdownEditor tabId="/r/doc.md" defaultValue={DOC} />);
  for (let i = 0; i < 200; i++) {
    const crepe = instances.at(-1);
    try {
      const view = crepe?.editor.ctx.get<{ state?: { doc: PmNode } }, 'editorView'>('editorView');
      if (crepe && view?.state) {
        return { doc: view.state.doc, remark: crepe.editor.ctx.get<RemarkLike, 'remark'>('remark') };
      }
    } catch {
      /* 尚未就绪 */
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error('Crepe 未挂载');
}

describe('源码行 ↔ Milkdown 位置(真实 Crepe)', () => {
  it.each([
    [1, 1, 'heading'],
    [3, 3, 'paragraph'],
    [4, 3, 'paragraph'], // 段落内的行 → 段落起始行(块级精度)
    [6, 6, 'paragraph'], // 列表项
    [7, 7, 'paragraph'],
    [9, 9, 'paragraph'],
    [11, 11, 'paragraph'], // 引用里的段落
    [14, 14, 'code_block'], // 代码块内按换行精确到行
    [15, 15, 'code_block'],
    [25, 25, 'paragraph'], // 链接引用定义之后仍对齐
  ])('源码第 %i 行 → 光标位置 → 回到第 %i 行(%s)', async (line, back, blockType) => {
    const { doc, remark } = await mounted();
    const tree = parseMarkdownTree(remark, DOC);
    const pos = posForSourceLine(doc, tree, line);
    expect(pos).not.toBeNull();
    expect(locateSourceLine(doc, tree, line)!.pm.type.name).toBe(blockType);
    expect(sourceLineAtPos(doc, tree, pos!)).toBe(back);
  });

  it('块间空行 → 下一个块;表格行各自对齐', async () => {
    const { doc, remark } = await mounted();
    const tree = parseMarkdownTree(remark, DOC);
    expect(locateSourceLine(doc, tree, 2)!.md.position!.start.line).toBe(3);
    expect(locateSourceLine(doc, tree, 20)!.md.position!.start.line).toBe(20);
    expect(locateSourceLine(doc, tree, 21)!.md.position!.start.line).toBe(21);
  });

  it('编辑中插入的空段落(序列化时丢弃)不打乱其后块的对齐', async () => {
    render(<MilkdownEditor tabId="/r/empty.md" defaultValue={'# Title\n\nfirst\n\nsecond\n\nthird\n'} />);
    let crepe: CrepeType | undefined;
    for (let i = 0; i < 200 && !crepe; i++) {
      try {
        if (instances.at(-1)?.editor.ctx.get<{ state?: unknown }, 'editorView'>('editorView').state) crepe = instances.at(-1);
      } catch {
        /* 尚未就绪 */
      }
      if (!crepe) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
      }
    }
    const view = crepe!.editor.ctx.get<
      { state: { doc: PmNode & { content: unknown }; schema: { nodes: Record<string, { create(): unknown }> }; tr: { insert(pos: number, nodes: unknown[]): unknown } }; dispatch(tr: unknown): void },
      'editorView'
    >('editorView');
    // 「first」之后插两个空段落(连按两次回车)
    const afterFirst = view.state.doc.child(0).nodeSize + view.state.doc.child(1).nodeSize;
    const p = view.state.schema.nodes.paragraph!;
    view.dispatch(view.state.tr.insert(afterFirst, [p.create(), p.create()]));
    const markdown = crepe!.getMarkdown();
    expect(markdown).toBe('# Title\n\nfirst\n\nsecond\n\nthird\n');
    const doc = view.state.doc;
    const tree = parseMarkdownTree(crepe!.editor.ctx.get<RemarkLike, 'remark'>('remark'), markdown);
    expect(locateSourceLine(doc, tree, 7)!.pm.textContent).toBe('third');
    expect(locateSourceLine(doc, tree, 5)!.pm.textContent).toBe('second');
    expect(sourceLineAtPos(doc, tree, posForSourceLine(doc, tree, 7)!)).toBe(7);
  });
});
