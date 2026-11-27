// @vitest-environment jsdom
// 真实 Crepe(不 mock):编辑模式下公式原样往返 —— 改公式之外的内容,公式字节不变;改公式本身按规范写回。见同目录 README.md。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node as PmNode } from '@milkdown/kit/prose/model';
import { configureMarkdownStyle } from '../../panels/Editor/milkdown-markdown-style';
import { configureMarkdownMath } from '../../panels/Editor/milkdown-math';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { isMilkdownUnsafe } from '../../panels/Editor/milkdown-roundtrip-safety';

const instances = vi.hoisted(() => [] as Crepe[]);

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

// 代码块的 CodeMirror 在 jsdom 里量坐标
Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const editors: Crepe[] = [];

/** 与 MilkdownEditor 相同的公式相关配置:Latex 开启(Crepe 默认)+ 序列化风格 + configureMarkdownMath。 */
async function open(markdown: string): Promise<{ crepe: Crepe; view: EditorView }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({ root, defaultValue: markdown, features: { [Crepe.Feature.ImageBlock]: false } });
  configureMarkdownStyle(crepe, markdown);
  configureMarkdownMath(crepe);
  editors.push(crepe);
  await crepe.create();
  return { crepe, view: crepe.editor.ctx.get<EditorView, 'editorView'>('editorView') };
}

afterEach(async () => {
  cleanup();
  instances.length = 0;
  for (const crepe of editors.splice(0)) await crepe.destroy();
  document.body.innerHTML = '';
});

function typeAfter(view: EditorView, needle: string, text: string): void {
  let pos = -1;
  view.state.doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text!.includes(needle)) pos = p + node.text!.indexOf(needle) + needle.length;
  });
  if (pos < 0) throw new Error(`找不到 ${needle}`);
  view.dispatch(view.state.tr.insertText(text, pos));
}

function changedLines(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) out.push(`${i + 1}: ${JSON.stringify(a[i])} → ${JSON.stringify(b[i])}`);
  }
  return out;
}

function findNode(doc: PmNode, pred: (n: PmNode) => boolean): { node: PmNode; pos: number } {
  let found: { node: PmNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (!found && pred(node)) found = { node, pos };
    return !found;
  });
  if (!found) throw new Error('找不到节点');
  return found;
}

// 审计用例 + 常见写法
const MATH_DOC = [
  '# Notes',
  '',
  'Energy $x_1 + y_2 = z_{max}$ here.',
  '',
  'Thin $a\\,b$ space and set $\\{x\\}$.',
  '',
  '$$',
  '\\int_0^1 x\\,dx',
  '$$',
  '',
  'Display $$E = mc^2$$ inline and $$ a_b $$ padded.',
  '',
  'Between $5 and $10 per seat, range $5-$10.',
  '',
  'Wrapped $a +',
  'b_1$ formula.',
  '',
  '- item $x_1$',
  '',
  '> quote $y^2$',
  '',
  '| a | b |',
  '| - | - |',
  '| $x_1$ | $\\alpha$ |',
  '',
  '$$$',
  'x $$ y',
  '$$$',
  '',
  '$$ \\label{eq}',
  'z_1',
  '$$',
  '',
  'Last line edit target.',
  '',
].join('\n');

describe('编辑模式下公式原样往返', () => {
  it('挂载即序列化:审计用例与常见写法全文不变', async () => {
    const { crepe } = await open(MATH_DOC);
    expect(crepe.getMarkdown()).toBe(MATH_DOC);
  });

  it('改公式之外的一处:全文只差那一行,公式字节不变', async () => {
    const { crepe, view } = await open(MATH_DOC);
    typeAfter(view, 'edit target', '!');
    expect(changedLines(MATH_DOC, crepe.getMarkdown())).toEqual([
      '34: "Last line edit target." → "Last line edit target!."',
    ]);
  });

  it('公式解析成公式节点(行内 math_inline、块 = 语言 LaTeX 的代码块),金额是文字', async () => {
    const { view } = await open(MATH_DOC);
    const inline: string[] = [];
    const blocks: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.type.name === 'math_inline') inline.push(String(node.attrs.value));
      if (node.type.name === 'code_block') blocks.push(`${String(node.attrs.language)}:${node.textContent}`);
    });
    expect(inline).toEqual(['x_1 + y_2 = z_{max}', 'a\\,b', '\\{x\\}', 'E = mc^2', 'a_b', 'a +\nb_1', 'x_1', 'y^2', 'x_1', '\\alpha']);
    expect(blocks).toEqual(['LaTeX:\\int_0^1 x\\,dx', 'LaTeX:x $$ y', 'LaTeX:z_1']);
    expect(view.state.doc.textContent).toContain('Between $5 and $10 per seat, range $5-$10.');
  });

  it('改公式本身:按规范写法写回,其余不变', async () => {
    const { crepe, view } = await open('a $$ x $$ b and $y$\n\n$$ meta\nold\n$$$\n');
    const math = findNode(view.state.doc, (n) => n.type.name === 'math_inline');
    // 同 Crepe 行内公式浮层的写回(setNodeAttribute value)
    view.dispatch(view.state.tr.setNodeAttribute(math.pos, 'value', 'x+1'));
    const block = findNode(view.state.doc, (n) => n.type.name === 'code_block');
    view.dispatch(view.state.tr.insertText('new', block.pos + 1, block.pos + 1 + block.node.content.size));
    expect(crepe.getMarkdown()).toBe('a $x+1$ b and $y$\n\n$$ meta\nnew\n$$\n');
  });

  it('未闭合的公式块写回时不补闭栏', async () => {
    const md = 'text\n\n$$\nx_1\n';
    const { crepe } = await open(md);
    expect(crepe.getMarkdown()).toBe(md);
  });

  it('```latex / ```math 围栏仍写成代码块,不变成 $$', async () => {
    const md = '```latex\n\\frac{a}{b}\n```\n\n```math\nx_1\n```\n\n```LaTeX\ny\n```\n';
    const { crepe, view } = await open(md);
    typeAfter(view, 'x_1', '2');
    expect(crepe.getMarkdown()).toBe(md.replace('x_1', 'x_12'));
  });

  it('输入 `$$ ` 新建的公式块写成 $$ 块', async () => {
    const { crepe, view } = await open('start\n');
    const end = view.state.doc.content.size;
    const codeBlock = view.state.schema.nodes.code_block!;
    view.dispatch(view.state.tr.insert(end, codeBlock.create({ language: 'LaTeX' }, view.state.schema.text('a^2'))));
    expect(crepe.getMarkdown()).toBe('start\n\n$$\na^2\n$$\n');
  });

  it('首个代码样结构是公式块时,之后的 ``` 代码块风格不被误判成缩进代码', async () => {
    // 无语言的代码块:风格误判成缩进代码时会被写成四空格缩进
    const md = '$$\nx\n$$\n\n```\nq\n```\n\nedit me\n';
    const { crepe, view } = await open(md);
    typeAfter(view, 'edit me', '!');
    expect(crepe.getMarkdown()).toBe(md.replace('edit me', 'edit me!'));
  });

  it('Pandoc 规则下不是公式的 `$`:中间的强调 / 链接照常解析', async () => {
    const md = 'Cost $5 *and* [link](https://e.com) $10.\n';
    const { crepe, view } = await open(md);
    expect(view.state.doc.textContent).toBe('Cost $5 and link $10.');
    let marks = 0;
    view.state.doc.descendants((n) => {
      marks += n.marks.length;
    });
    expect(marks).toBe(2);
    expect(crepe.getMarkdown()).toBe(md);
  });

  it('同段有含 `$` 的行内代码:文中的 `$` 仍不转义(第四十八轮审计 A5)', async () => {
    const md = '`$HOME` then $PATH and `x $` here.\n';
    const { crepe, view } = await open(md);
    typeAfter(view, 'then', '!');
    expect(crepe.getMarkdown()).toBe(md.replace('then', 'then!'));
  });

  it('行内代码里的 `$` 会与文中 `$` 配成公式时:文中 `$` 照样转义', async () => {
    const md = 'a \\$b `c$` d\n';
    const { crepe, view } = await open(md);
    expect(view.state.doc.textContent).toBe('a $b c$ d');
    typeAfter(view, ' d', '!');
    expect(crepe.getMarkdown()).toBe('a \\$b `c$` d!\n');
  });

  it('含公式的文档不再判为不安全(不锁源码模式);同时含引用定义仍锁', () => {
    expect(isMilkdownUnsafe(MATH_DOC)).toBe(false);
    expect(isMilkdownUnsafe(`${MATH_DOC}\n[ref]: https://example.com\n`)).toBe(true);
  });
});

describe('MilkdownEditor 接上了公式', () => {
  async function waitMounted(): Promise<Crepe> {
    for (let i = 0; i < 100; i++) {
      const crepe = instances.at(-1);
      try {
        if (crepe && crepe.editor.ctx.get<{ state?: unknown }, 'editorView'>('editorView').state) {
          await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
          });
          return crepe;
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

  it('编辑模式改一处,卸载回写的全文只差那一处,公式字节不变', async () => {
    const onWriteBack = vi.fn();
    const { unmount, container } = render(<MilkdownEditor tabId="/m.md" defaultValue={MATH_DOC} onWriteBack={onWriteBack} />);
    const crepe = await waitMounted();
    expect(container.querySelectorAll('[data-type="math_inline"]').length).toBe(10);
    typeAfter(crepe.editor.ctx.get<EditorView, 'editorView'>('editorView'), 'edit target', '!');
    unmount();
    expect(onWriteBack).toHaveBeenCalledTimes(1);
    expect(changedLines(MATH_DOC, onWriteBack.mock.calls[0]![0] as string)).toEqual([
      '34: "Last line edit target." → "Last line edit target!."',
    ]);
  });
});
