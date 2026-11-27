// @vitest-environment jsdom
// 真实 Crepe(不 mock):编辑模式改一处后保存,文件只变改动的那一行 —— 序列化风格跟随原文件,不写 `<br />` 空行占位,
// 不加多余转义(第四十七轮审计 B4 / B8)。见同目录 README.md。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import {
  configureMarkdownStyle,
  dropNeedlessEscapes,
  inferMarkdownStyleParts,
  inferTablePipeAlign,
} from '../../panels/Editor/milkdown-markdown-style';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';

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

const editors: Crepe[] = [];

/** 与 MilkdownEditor 相同的 Crepe 配置(不启用图片 / 公式)+ 序列化风格。 */
async function open(markdown: string): Promise<{ crepe: Crepe; view: EditorView }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({
    root,
    defaultValue: markdown,
    features: { [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.Latex]: false },
  });
  configureMarkdownStyle(crepe, markdown);
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

/** 在第一处 `needle` 后插入文字(模拟「编辑一字」)。 */
function typeAfter(view: EditorView, needle: string, text: string): void {
  let pos = -1;
  view.state.doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text!.includes(needle)) pos = p + node.text!.indexOf(needle) + needle.length;
  });
  if (pos < 0) throw new Error(`找不到 ${needle}`);
  view.dispatch(view.state.tr.insertText(text, pos));
}

/** 逐行比较,返回不同的行(行数不同时多出的行也算)。 */
function changedLines(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) out.push(`${i + 1}: ${JSON.stringify(a[i])} → ${JSON.stringify(b[i])}`);
  }
  return out;
}

// Prettier 风格的 GFM 文档(`-` 列表、`---`、ATX 标题、``` 围栏、对齐的表格)。
const PRETTIER_DOC = [
  '# Writing',
  '',
  'Intro with *emphasis*, **strong**, ~~strike~~, `code`, [link](https://example.com), 2 * 3 and snake_case_name.',
  '',
  'Escapes that matter stay: \\_\\_init\\_\\_ and \\*not emphasis\\*.',
  '',
  '## Tasks',
  '',
  '- [ ] task one',
  '- [x] task two',
  '',
  '## Lists',
  '',
  '- plain item',
  '  - nested item',
  '',
  '1. first',
  '2. second',
  '',
  '> quote line',
  '',
  '---',
  '',
  '| Name | Value |',
  '| ---- | ----- |',
  '| a    | 1     |',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A --> B',
  '```',
  '',
  'Line one<br />line two',
  '',
  '<br />',
  '',
  'Tail paragraph.',
  '',
].join('\n');

// 另一种常见风格:`*` 列表、`1)`、`***`、setext 标题、缩进代码、不对齐的表格。
const OTHER_DOC = [
  'Title',
  '=====',
  '',
  '* star item',
  '* second',
  '',
  '1) one',
  '2) two',
  '',
  '***',
  '',
  '    indented code',
  '    line two',
  '',
  '| a | b |',
  '| - | - |',
  '| longer cell | x |',
  '',
  'Sub',
  '---',
  '',
  'text',
  '',
].join('\n');

describe('编辑一字后保存:只有改动的那一行变化', () => {
  it('Prettier 风格的 GFM 文档(任务列表 / 嵌套列表 / 表格 / 代码块 / mermaid / 手写 <br />)', async () => {
    const { crepe, view } = await open(PRETTIER_DOC);
    typeAfter(view, 'task one', '!');
    expect(changedLines(PRETTIER_DOC, crepe.getMarkdown())).toEqual([
      '9: "- [ ] task one" → "- [ ] task one!"',
    ]);
  });

  it('`*` 列表 / `1)` / `***` / setext 标题 / 缩进代码 / 不对齐的表格:风格保持', async () => {
    const { crepe, view } = await open(OTHER_DOC);
    typeAfter(view, 'star item', '!');
    expect(changedLines(OTHER_DOC, crepe.getMarkdown())).toEqual(['4: "* star item" → "* star item!"']);
  });

  it('原文件没有的结构按 Prettier 默认:新列表用 `-`、新分隔线 `---`', async () => {
    const { crepe, view } = await open('# T\n\nbody\n');
    const { schema } = view.state;
    const end = view.state.doc.content.size;
    view.dispatch(
      view.state.tr.insert(end, [
        schema.nodes.bullet_list!.create(null, schema.nodes.list_item!.create(null, schema.nodes.paragraph!.create(null, schema.text('new')))),
        schema.nodes.hr!.create(),
      ]),
    );
    expect(crepe.getMarkdown()).toBe('# T\n\nbody\n\n- new\n\n---\n');
  });
});

describe('空行与转义', () => {
  it('连按两次回车留下的空段落不写成 <br />;手写的 <br /> 原样保留', async () => {
    const { crepe, view } = await open('Para one\n\n<br />\n\nPara two\n');
    const { schema } = view.state;
    const end = view.state.doc.content.size;
    view.dispatch(
      view.state.tr.insert(end, [
        schema.nodes.paragraph!.create(),
        schema.nodes.paragraph!.create(),
        schema.nodes.paragraph!.create(null, schema.text('after')),
      ]),
    );
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    expect(crepe.getMarkdown()).toBe('Para one\n\n<br />\n\nPara two\n\nafter\n');
  });

  it('不会被解析成强调的 `*` / `_` 不转义,会被误解析的照样转义', () => {
    expect(dropNeedlessEscapes('2 \\* 3 and snake\\_case\\_name')).toBe('2 * 3 and snake_case_name');
    expect(dropNeedlessEscapes('\\* at start')).toBe('\\* at start');
    expect(dropNeedlessEscapes('a \\*b')).toBe('a \\*b');
    expect(dropNeedlessEscapes('\\_\\_init\\_\\_ x\\_')).toBe('\\_\\_init\\_\\_ x\\_');
    expect(dropNeedlessEscapes('中\\_文')).toBe('中_文');
  });

  it('表格对齐按原文件第一个表格各行是否等宽', () => {
    expect(inferTablePipeAlign('| Name | Value |\n| ---- | ----- |\n| a    | 1     |\n')).toBe(true);
    expect(inferTablePipeAlign('| a | b |\n| - | - |\n| longer cell | x |\n')).toBe(false);
    expect(inferTablePipeAlign('a|b\n-|-\nlonger|x\n')).toBe(false);
    expect(inferTablePipeAlign('no table\n')).toBe(true);
  });
});

describe('被改动的块里的写法跟随原文件(第四十八轮审计 A4)', () => {
  it('文中 `[x]` 不转义;段首、后面是 `(` / `[` / `:`、脚注样式照样转义', () => {
    expect(dropNeedlessEscapes('see \\[x] here')).toBe('see [x] here');
    expect(dropNeedlessEscapes('see \\[x]')).toBe('see [x]');
    expect(dropNeedlessEscapes('\\[x] at start')).toBe('\\[x] at start');
    expect(dropNeedlessEscapes('a \\[x](y)')).toBe('a \\[x](y)');
    expect(dropNeedlessEscapes('a \\[x]', '(')).toBe('a \\[x]');
    expect(dropNeedlessEscapes('a \\[x]', '[')).toBe('a \\[x]');
    expect(dropNeedlessEscapes('a \\[x]: y')).toBe('a \\[x]: y');
    expect(dropNeedlessEscapes('a \\[^1] b')).toBe('a \\[^1] b');
    expect(dropNeedlessEscapes('a !\\[x] b')).toBe('a !\\[x] b');
  });

  it('推断:`1. 1.` 不递增、硬换行写法、裸链接 / 尖括号链接', async () => {
    const parse = async (md: string) => {
      const { crepe } = await open(md);
      const remark = crepe.editor.ctx.get<{ parse(s: string): unknown; runSync(t: unknown, f?: string): unknown }, 'remark'>('remark');
      return inferMarkdownStyleParts(remark.runSync(remark.parse(md), md) as never, md);
    };
    expect(await parse('1. a\n1. b\n')).toMatchObject({ incrementListMarker: false, bulletOrdered: '.' });
    expect(await parse('3) a\n4) b\n')).toMatchObject({ incrementListMarker: true, bulletOrdered: ')' });
    expect(await parse('a  \nb\n')).toMatchObject({ continuoHardBreak: 'spaces' });
    expect(await parse('a\\\nb\n')).toMatchObject({ continuoHardBreak: 'backslash' });
    expect(await parse('see https://a.com now\n')).toMatchObject({ continuoAutolink: 'literal' });
    expect(await parse('see <https://a.com> now\n')).toMatchObject({ continuoAutolink: 'angle' });
    expect(await parse('see [https://a.com](https://a.com) now\n')).not.toHaveProperty('continuoAutolink');
  });

  it('编辑整段后:`1. 1. 1.`、行尾两空格硬换行、裸链接(句末标点、换行后、段首)都保持', async () => {
    const md = '1. one\n1. two\n\nHard  \nbreak https://b.com. and\nhttps://c.com/x?y=1\n\nhttps://d.com\n';
    const { crepe, view } = await open(md);
    typeAfter(view, 'two', '!');
    typeAfter(view, 'and', '!');
    typeAfter(view, 'Hard', '!');
    expect(crepe.getMarkdown()).toBe(
      '1. one\n1. two!\n\nHard!  \nbreak https://b.com. and!\nhttps://c.com/x?y=1\n\nhttps://d.com\n',
    );
  });

  it('裸写会改变解析结果的链接仍写成 <url>(后面紧跟字母 / 地址以标点结尾)', async () => {
    const { crepe, view } = await open('see https://a.com now\n');
    const { schema } = view.state;
    const link = (href: string) => schema.marks.link!.create({ href });
    view.dispatch(
      view.state.tr.insert(view.state.doc.content.size - 1, [
        schema.text(' x '),
        schema.text('https://e.com', [link('https://e.com')]),
        schema.text('abc '),
        schema.text('https://f.com/.', [link('https://f.com/.')]),
      ]),
    );
    expect(crepe.getMarkdown()).toBe('see https://a.com now x <https://e.com>abc <https://f.com/.>\n');
  });
});

describe('MilkdownEditor 接上了序列化风格', () => {
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

  it('编辑模式改一处,卸载回写的全文只差那一处', async () => {
    const onWriteBack = vi.fn();
    const { unmount } = render(<MilkdownEditor tabId="/t.md" defaultValue={OTHER_DOC} onWriteBack={onWriteBack} />);
    const crepe = await waitMounted();
    typeAfter(crepe.editor.ctx.get<EditorView, 'editorView'>('editorView'), 'star item', '!');
    unmount();
    expect(onWriteBack).toHaveBeenCalledTimes(1);
    expect(changedLines(OTHER_DOC, onWriteBack.mock.calls[0]![0] as string)).toEqual([
      '4: "* star item" → "* star item!"',
    ]);
  });
});
