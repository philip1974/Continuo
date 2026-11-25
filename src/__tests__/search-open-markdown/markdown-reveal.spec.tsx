// @vitest-environment jsdom
// BDD:在文件中查找打开 Markdown 结果,编辑 / 预览(Milkdown)模式下定位并选中匹配(见同目录 README)。
// 真实 Crepe:映射用它的 remark 处理器与它建出的 ProseMirror 文档;定位经 markdown-reveal-registry 交给已挂载 / 稍后挂载的视图。
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Crepe as CrepeType } from '@milkdown/crepe';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { parseMarkdownTree, rangeForSourceMatch, type PmNode, type RemarkLike } from '../../panels/Editor/markdown-position-map';
import { __resetMarkdownRevealForTest, revealInMarkdown } from '../../panels/Editor/markdown-reveal-registry';
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

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  // jsdom 无 elementFromPoint(ProseMirror mousedown 按坐标取位置要用)
  document.elementFromPoint ??= () => null;
});
afterEach(() => {
  cleanup();
  instances.length = 0;
  __resetMarkdownRevealForTest();
});

const TAB = '/r/doc.md';
const DOC = [
  '# Title foo', // 1
  '', // 2
  'Intro foo and **foo**', // 3
  'spanning foo', // 4
  '', // 5
  '- item foo', // 6
  '- [foo](foo.md) x foo', // 7
  '', // 8
  '| h1 | h2 |', // 9
  '| -- | -- |', // 10
  '| foo | foo |', // 11
  '', // 12
  '```js', // 13
  'const foo = 1;', // 14
  'foo();', // 15
  '```', // 16
  '', // 17
  'Last foo', // 18
  '',
].join('\n');

interface Doc extends PmNode {
  textBetween(from: number, to: number): string;
  resolve(pos: number): { parent: { type: { name: string }; textContent: string }; parentOffset: number; depth: number; index(depth: number): number; start(): number };
}
interface View {
  state: { doc: Doc; selection: { from: number; to: number } };
  dom: HTMLElement;
}

async function mounted(): Promise<{ view: View; remark: RemarkLike }> {
  for (let i = 0; i < 200; i++) {
    const crepe = instances.at(-1);
    try {
      const view = crepe?.editor.ctx.get<View, 'editorView'>('editorView');
      if (crepe && view?.state && document.querySelector('.ProseMirror[aria-label]')) {
        return { view, remark: crepe.editor.ctx.get<RemarkLike, 'remark'>('remark') };
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

/** 源码第 line 行里第 nth 个 needle 的列(1 起)。 */
function columnOf(line: number, needle: string, nth = 0): number {
  const text = DOC.split('\n')[line - 1]!;
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1);
  return at + 1;
}

describe('源码匹配 → 文档范围(真实 Crepe)', () => {
  it.each([
    ['标题', 1, 0, 'heading', 'Title '],
    ['段落第一处', 3, 0, 'paragraph', 'Intro '],
    ['粗体里的第二处(标记符号不计)', 3, 1, 'paragraph', 'Intro foo and '],
    ['段落第二行(软换行)', 4, 0, 'paragraph', 'spanning '],
    ['列表项', 6, 0, 'paragraph', 'item '],
    ['链接文字之后同一行的另一处(链接地址里的出现不计)', 7, 2, 'paragraph', 'foo x '],
    ['表格第一个单元格(从行首的单元格数起)', 11, 0, 'paragraph', '', 0],
    ['表格第二个单元格', 11, 1, 'paragraph', '', 1],
    ['代码块内的行(从正文首行数起)', 15, 0, 'code_block', 'const foo = 1;\n'],
    ['末段', 18, 0, 'paragraph', 'Last '],
  ])('%s:选中的正是那一处', async (_name, line, nth, blockType, before, cell?: number) => {
    render(<MilkdownEditor tabId={TAB} defaultValue={DOC} />);
    const { view, remark } = await mounted();
    const doc = view.state.doc;
    const range = rangeForSourceMatch(doc, parseMarkdownTree(remark, DOC), DOC, line, columnOf(line, 'foo', nth), 3)!;
    expect(doc.textBetween(range.from, range.to)).toBe('foo');
    const $from = doc.resolve(range.from);
    expect($from.parent.type.name).toBe(blockType);
    // 块正文里匹配之前的文字:软换行之后的行只比对行内部分
    const prefix = $from.parent.textContent.slice(0, $from.parentOffset);
    if (line === 4) expect(prefix.endsWith(before) && prefix.length > before.length).toBe(true);
    else expect(prefix).toBe(before);
    if (cell !== undefined) expect($from.index($from.depth - 2)).toBe(cell);
  });

  it('未给长度 → 光标放在块起点;行号超出源码 → null', async () => {
    render(<MilkdownEditor tabId={TAB} defaultValue={DOC} />);
    const { view, remark } = await mounted();
    const tree = parseMarkdownTree(remark, DOC);
    const range = rangeForSourceMatch(view.state.doc, tree, DOC, 18, 6)!;
    expect(range.from).toBe(range.to);
    expect(view.state.doc.textBetween(range.from, range.from + 8)).toBe('Last foo');
    expect(rangeForSourceMatch(view.state.doc, tree, DOC, 999, 1, 3)).toBeNull();
  });
});

describe('打开并定位(markdown-reveal-registry → MilkdownEditor)', () => {
  it('视图已就绪:下一帧选中匹配并聚焦编辑区', async () => {
    render(<MilkdownEditor tabId={TAB} defaultValue={DOC} />);
    const { view } = await mounted();
    let outcome: string | undefined;
    await act(async () => {
      outcome = await revealInMarkdown(TAB, { line: 18, column: 6, length: 3 }, PRIMARY_EDITOR_GROUP_ID);
    });
    expect(outcome).toBe('applied');
    const { from, to } = view.state.selection;
    expect(view.state.doc.textBetween(from, to)).toBe('foo');
    expect(view.state.doc.resolve(from).parent.textContent).toBe('Last foo');
    expect(view.dom.contains(document.activeElement)).toBe(true);
  });

  it('请求先于视图就绪(刚打开、Crepe 异步创建):就绪后兑现', async () => {
    const pending = revealInMarkdown(TAB, { line: 4, column: 10, length: 3 }, PRIMARY_EDITOR_GROUP_ID);
    render(<MilkdownEditor tabId={TAB} defaultValue={DOC} />);
    const { view } = await mounted();
    let outcome: string | undefined;
    await act(async () => {
      outcome = await pending;
    });
    expect(outcome).toBe('applied');
    const { from, to } = view.state.selection;
    expect(view.state.doc.textBetween(from, to)).toBe('foo');
    // 段落「Intro foo and foo / spanning foo」的第三处
    expect(view.state.doc.textBetween(view.state.doc.resolve(from).start(), to).split('foo').length - 1).toBe(3);
  });

  it('只读预览同样定位;行号超出 → out-of-range;新请求取代未兑现的旧请求', async () => {
    const stale = revealInMarkdown(TAB, { line: 1, column: 1, length: 1 }, PRIMARY_EDITOR_GROUP_ID);
    const fresh = revealInMarkdown(TAB, { line: 999 }, PRIMARY_EDITOR_GROUP_ID);
    expect(await stale).toBe('not-mounted');
    render(<MilkdownEditor tabId={TAB} defaultValue={DOC} readonly />);
    const { view } = await mounted();
    await act(async () => {
      expect(await fresh).toBe('out-of-range');
    });
    await act(async () => {
      expect(await revealInMarkdown(TAB, { line: 6, column: 8, length: 3 }, PRIMARY_EDITOR_GROUP_ID)).toBe('applied');
    });
    const { from, to } = view.state.selection;
    expect(view.state.doc.textBetween(from, to)).toBe('foo');
    expect(view.dom.contains(document.activeElement)).toBe(true);
  });

  it('只读预览不画 DOM 选区:匹配用「当前匹配」高亮标出,点击正文后清除;编辑模式只靠选区,不加高亮', async () => {
    const { container, unmount } = render(<MilkdownEditor tabId={TAB} defaultValue={DOC} readonly />);
    const { view } = await mounted();
    await act(async () => {
      expect(await revealInMarkdown(TAB, { line: 18, column: 6, length: 3 }, PRIMARY_EDITOR_GROUP_ID)).toBe('applied');
    });
    const marks = container.querySelectorAll('.co-find-match-current');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe('foo');
    expect(marks[0]!.closest('p')?.textContent).toBe('Last foo');
    act(() => {
      fireEvent.mouseDown(view.dom);
    });
    expect(container.querySelectorAll('.co-find-match-current')).toHaveLength(0);
    unmount();
    instances.length = 0;

    const edit = render(<MilkdownEditor tabId={TAB} defaultValue={DOC} />);
    await mounted();
    await act(async () => {
      expect(await revealInMarkdown(TAB, { line: 18, column: 6, length: 3 }, PRIMARY_EDITOR_GROUP_ID)).toBe('applied');
    });
    expect(edit.container.querySelectorAll('.co-find-match-current')).toHaveLength(0);
  });
});
