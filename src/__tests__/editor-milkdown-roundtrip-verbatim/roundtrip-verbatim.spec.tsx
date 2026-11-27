// @vitest-environment jsdom
// 真实 Crepe(不 mock):编辑模式改一处保存,只有那一块变化 —— 未改动的块原样写回、块间空行与文末空行照旧、CRLF 行尾保持;
// 被改动的块里常见写法(无首尾竖线 / 紧凑表格、`1. 1. 1.`、裸链接、行尾两空格硬换行、文中 `[x]`)也保持(第四十八轮审计 A2–A4)。
// 见同目录 README.md。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { undo } from '@milkdown/kit/prose/history';
import type { Node as PmNode } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { configureMarkdownStyle } from '../../panels/Editor/milkdown-markdown-style';
import { configureMarkdownMath } from '../../panels/Editor/milkdown-math';
import { configureSourceBlocks, sameBlock, splitTableRow } from '../../panels/Editor/milkdown-source-blocks';
import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';
import { markdownWritingKeys } from '../../panels/Editor/milkdown-writing-keys';

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

/** 与 MilkdownEditor 相同的序列化配置(风格 + 原样写回 + 公式 + 写作按键:编辑自动链接时地址跟随文字)。 */
async function open(markdown: string): Promise<{ crepe: Crepe; view: EditorView }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({ root, defaultValue: markdown, features: { [Crepe.Feature.ImageBlock]: false } });
  configureMarkdownStyle(crepe, markdown);
  configureSourceBlocks(crepe, markdown);
  configureMarkdownMath(crepe);
  crepe.editor.use(markdownWritingKeys);
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

/** 文档里第一处 `needle` 之后的位置。 */
function posAfter(view: EditorView, needle: string): number {
  let pos = -1;
  view.state.doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text!.includes(needle)) pos = p + node.text!.indexOf(needle) + needle.length;
  });
  if (pos < 0) throw new Error(`找不到 ${needle}`);
  return pos;
}

function typeAfter(view: EditorView, needle: string, text: string): void {
  view.dispatch(view.state.tr.insertText(text, posAfter(view, needle)));
}

/** 逐行比较(按 \n 切,CR 留在行里),返回不同的行。 */
function changedLines(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) out.push(`${i + 1}: ${JSON.stringify(a[i])} → ${JSON.stringify(b[i])}`);
  }
  return out;
}

// 审计列出的常见写法(均不是 remark-stringify 的写法)+ 文末多余空行
const FIXTURE = [
  '# Writing', // 1
  '',
  'Bare link https://b.com. and [x] in text, `$HOME` then $PATH.', // 3
  '',
  'Hard break  ', // 5
  'next line', // 6
  '',
  '| a | b |', // 8
  '|---|---|',
  '| 1 | 2 |', // 10
  '',
  '| a | b |', // 12
  '| --- | --- |',
  '| 1 | 2 |', // 14
  '',
  '|left|right|', // 16
  '|:----:|------:|',
  '|1|2|', // 18
  '',
  'x | y', // 20
  '--|--',
  'p | q', // 22
  '',
  '| Name | Value |', // 24
  '| ---- | ----- |',
  '| qq   | 1     |', // 26
  '',
  '1. one', // 28
  '1. two', // 29
  '1. three',
  '',
  '* star', // 32
  '* item', // 33
  '',
  'Final paragraph.', // 35
  '',
  '',
  '',
].join('\n');

describe('改一处只变那一行', () => {
  it('挂载后未编辑:序列化结果与原文逐字节相同', async () => {
    const { crepe } = await open(FIXTURE);
    expect(crepe.getMarkdown()).toBe(FIXTURE);
  });

  const cases: ReadonlyArray<readonly [needle: string, line: number, expected: string]> = [
    ['Final paragraph', 35, 'Final paragraphZ.'],
    ['Writing', 1, '# WritingZ'],
    // 被改动的块里:裸链接、`[x]`、行内代码里的 `$` 与文中 `$` 都保持
    ['Bare link', 3, 'Bare linkZ https://b.com. and [x] in text, `$HOME` then $PATH.'],
    // 行尾两空格硬换行保持
    ['next line', 6, 'next lineZ'],
    ['Hard break', 5, 'Hard breakZ  '],
    // 表格逐行:改动的行按原表格的竖线 / 空格写,分隔行与其余行原样
    ['1', 10, '| 1Z | 2 |'],
    ['left', 16, '|leftZ|right|'],
    ['q', 22, 'p | qZ'],
    // Prettier 对齐的表格:列宽不变时只变那一行
    ['qq', 26, '| qqZ  | 1     |'],
    // `1. 1. 1.` 不重新编号;`*` 列表符号保持
    ['two', 29, '1. twoZ'],
    ['item', 33, '* itemZ'],
  ];
  for (const [needle, line, expected] of cases) {
    it(`改「${needle}」→ 只有第 ${line} 行变化`, async () => {
      const { crepe, view } = await open(FIXTURE);
      typeAfter(view, needle, 'Z');
      const lines = FIXTURE.split('\n');
      expect(changedLines(FIXTURE, crepe.getMarkdown())).toEqual([
        `${line}: ${JSON.stringify(lines[line - 1])} → ${JSON.stringify(expected)}`,
      ]);
    });
  }

  it('Prettier 对齐的表格某列变宽:整表按 Prettier 重新对齐(其余块不变)', async () => {
    const { crepe, view } = await open(FIXTURE);
    typeAfter(view, 'Value', 'Z');
    expect(changedLines(FIXTURE, crepe.getMarkdown())).toEqual([
      '24: "| Name | Value |" → "| Name | ValueZ |"',
      '25: "| ---- | ----- |" → "| ---- | ------ |"',
      '26: "| qq   | 1     |" → "| qq   | 1      |"',
    ]);
  });

  it('表格加一列(分隔行列数变化):按原表格写法重写分隔行', async () => {
    const { crepe, view } = await open('|a|b|\n|---|---|\n|1|2|\n\ntail\n');
    const table = view.state.doc.child(0);
    const { schema } = view.state;
    const rows: PmNode[] = [];
    table.forEach((row) => {
      const cells: PmNode[] = [];
      row.forEach((c) => cells.push(c));
      cells.push(row.child(0).type.create(row.child(0).attrs, schema.nodes.paragraph!.create(null, schema.text('n'))));
      rows.push(row.type.create(row.attrs, cells));
    });
    view.dispatch(view.state.tr.replaceWith(0, table.nodeSize, table.type.create(table.attrs, rows)));
    expect(crepe.getMarkdown()).toBe('|a|b|n|\n|---|---|---|\n|1|2|n|\n\ntail\n');
  });
});

describe('CRLF 行尾', () => {
  it('CRLF 文档改一字:整篇仍是 CRLF,只变那一行', async () => {
    const crlf = FIXTURE.replace(/\n/g, '\r\n');
    const { crepe, view } = await open(crlf);
    expect(crepe.getMarkdown()).toBe(crlf);
    typeAfter(view, 'Final paragraph', 'Z');
    const out = crepe.getMarkdown();
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(changedLines(crlf, out)).toEqual(['35: "Final paragraph.\\r" → "Final paragraphZ.\\r"']);
  });

  it('CRLF 文档新建的块(走 remark)也写 CRLF', async () => {
    const { crepe, view } = await open('a\r\n\r\nb\r\n');
    const { schema } = view.state;
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, schema.nodes.paragraph!.create(null, schema.text('c'))));
    expect(crepe.getMarkdown()).toBe('a\r\n\r\nb\r\n\r\nc\r\n');
  });

  it('空文件里新写的内容按 remark 以换行结尾;原文没有末尾换行的仍没有', async () => {
    const empty = await open('');
    empty.view.dispatch(empty.view.state.tr.insertText('hello', 1));
    expect(empty.crepe.getMarkdown()).toBe('hello\n');
    const bare = await open('a\n\nb');
    typeAfter(bare.view, 'b', 'Z');
    expect(bare.crepe.getMarkdown()).toBe('a\n\nbZ');
  });

  it('LF 与混合行尾的文档不改行尾', async () => {
    const mixed = 'a\r\n\r\nb\nc\n';
    const { crepe, view } = await open(mixed);
    typeAfter(view, 'a', 'Z');
    expect(crepe.getMarkdown()).toBe('aZ\r\n\r\nb\nc\n');
  });
});

describe('块移动 / 撤销 / 拆分合并', () => {
  const DOC = '# T\n\n|a|b|\n|-|-|\n|1|2|\n\n1. x\n1. y\n\npara one\n\n\npara two\n';

  it('拖动重排顶层块:被移动的块与其余块都原样', async () => {
    const { crepe, view } = await open(DOC);
    const doc = view.state.doc;
    const table = doc.child(1);
    const tableFrom = doc.child(0).nodeSize;
    const end = doc.content.size;
    // 把表格移到文末(同 ProseMirror 拖放:删除后在别处插入同一切片)
    const slice = doc.slice(tableFrom, tableFrom + table.nodeSize);
    const tr = view.state.tr.insert(end, slice.content).delete(tableFrom, tableFrom + table.nodeSize);
    view.dispatch(tr);
    expect(crepe.getMarkdown()).toBe('# T\n\n1. x\n1. y\n\npara one\n\n\npara two\n\n|a|b|\n|-|-|\n|1|2|\n');
  });

  it('编辑后撤销:逐字节回到原文', async () => {
    const { crepe, view } = await open(DOC);
    typeAfter(view, 'para one', 'Z');
    typeAfter(view, 'x', 'Q');
    expect(crepe.getMarkdown()).not.toBe(DOC);
    undo(view.state, view.dispatch);
    undo(view.state, view.dispatch);
    expect(crepe.getMarkdown()).toBe(DOC);
  });

  it('删掉一个字再输回同一个字(内容相同、节点不同):仍原样', async () => {
    const { crepe, view } = await open(DOC);
    const pos = posAfter(view, 'para on');
    view.dispatch(view.state.tr.delete(pos, pos + 1));
    view.dispatch(view.state.tr.insertText('e', pos));
    expect(crepe.getMarkdown()).toBe(DOC);
  });

  it('段落拆成两段:新段走 remark,其余块原样', async () => {
    const { crepe, view } = await open(DOC);
    const pos = posAfter(view, 'para o');
    view.dispatch(view.state.tr.split(pos));
    expect(crepe.getMarkdown()).toBe('# T\n\n|a|b|\n|-|-|\n|1|2|\n\n1. x\n1. y\n\npara o\n\nne\n\npara two\n');
  });

  it('两段合并成一段:其余块原样', async () => {
    const { crepe, view } = await open(DOC);
    const pos = posAfter(view, 'para one');
    // 删掉两段之间的段落边界 = 合并
    view.dispatch(view.state.tr.delete(pos, pos + 2));
    expect(crepe.getMarkdown()).toBe('# T\n\n|a|b|\n|-|-|\n|1|2|\n\n1. x\n1. y\n\npara onepara two\n');
  });

  it('两个原文不相邻的列表移到一起:不原样拼接(否则合并成一个列表),按 remark 换用列表符号', async () => {
    const { crepe, view } = await open('- a\n\npara\n\n- b\n');
    const doc = view.state.doc;
    const p = doc.child(0).nodeSize;
    view.dispatch(view.state.tr.delete(p, p + doc.child(1).nodeSize));
    const out = crepe.getMarkdown();
    expect(out).toBe('- a\n\n* b\n');
  });

  it('列表里加一项:其余项原样,新项按原列表的符号 / 编号写', async () => {
    const { crepe, view } = await open('1) one\n1) two\n\n+ a\n+ b\n');
    // 在 two 之后回车新起一项
    const pos = posAfter(view, 'two');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    const { schema } = view.state;
    const list = view.state.doc.child(0);
    const item = list.child(1).type.create(null, schema.nodes.paragraph!.create(null, schema.text('three')));
    view.dispatch(view.state.tr.insert(list.nodeSize - 1, item));
    expect(crepe.getMarkdown()).toBe('1) one\n1) two\n1) three\n\n+ a\n+ b\n');
  });
});

describe('没闭合的围栏代码块在文末', () => {
  // 第四十九轮审计 A2:没闭合的围栏延伸到文末,其区间吞掉了文末换行;后面再接块 / 改动它时不原样写,文末换行曾丢失
  const UNCLOSED = '# F\n\nPara.\n\n```js\nconst a = 1;\n';

  function appendParagraph(view: EditorView, text: string): void {
    const { schema } = view.state;
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, schema.nodes.paragraph!.create(null, schema.text(text))));
  }

  it('代码块后新起一段:围栏补上闭合,文末换行保留', async () => {
    const { crepe, view } = await open(UNCLOSED);
    expect(crepe.getMarkdown()).toBe(UNCLOSED);
    appendParagraph(view, 'AFTERCODE');
    expect(crepe.getMarkdown()).toBe('# F\n\nPara.\n\n```js\nconst a = 1;\n```\n\nAFTERCODE\n');
  });

  it('CRLF 文档:同样保留文末换行,且是 CRLF', async () => {
    const crlf = UNCLOSED.replace(/\n/g, '\r\n');
    const { crepe, view } = await open(crlf);
    appendParagraph(view, 'AFTERCODE');
    const out = crepe.getMarkdown();
    expect(out).toBe('# F\r\n\r\nPara.\r\n\r\n```js\r\nconst a = 1;\r\n```\r\n\r\nAFTERCODE\r\n');
  });

  it('改动代码块本身(其后没有块):文末换行保留', async () => {
    const { crepe, view } = await open(UNCLOSED);
    typeAfter(view, 'const a', 'Z');
    expect(crepe.getMarkdown()).toMatch(/const aZ = 1;\n```\n$/);
  });

  it('原文没有文末换行:输出也不加', async () => {
    const bare = UNCLOSED.slice(0, -1);
    const { crepe, view } = await open(bare);
    appendParagraph(view, 'AFTERCODE');
    expect(crepe.getMarkdown()).toBe('# F\n\nPara.\n\n```js\nconst a = 1;\n```\n\nAFTERCODE');
  });
});

describe('被改动的段落里有跨行的行内代码', () => {
  // 第五十轮:`$b `$` 按 Pandoc 规则是公式(吞掉一个反引号),其后的反引号两两错配,成了跨行(含硬换行那一行)的行内代码;
  // remark 写行内代码时把「换行 + 可能被当成块开头的字符」换成空格、去掉两端补的空格 —— 改一字,整段被改写(看起来像
  // 硬换行丢了、反引号错位),解析回来行内代码的内容也变了
  const cases: ReadonlyArray<readonly [doc: string, needle: string, expected: string]> = [
    // 模糊测试最小化:公式吞掉反引号 + 行尾两空格硬换行 + 下一行以 `[` 开头
    ['a $b `$c` x  \n[y](u) `z`\n', 'a', 'aq $b `$c` x  \n[y](u) `z`\n'],
    // 裸链接 + 含 `$` 的行内代码 + 硬换行(模糊测试原例的缩写)
    [
      'Bare https://b.com/p. `$HOME` then $PATH `$HOME` then $PATH  \n[delta](https://ex.com/5) $5 and $10 `alpha`\n',
      'then',
      'Bare https://b.com/p. `$HOME` thenq $PATH `$HOME` then $PATH  \n[delta](https://ex.com/5) $5 and $10 `alpha`\n',
    ],
    // 与 `$` 无关:本就跨行的行内代码
    ['a `x\n#y` b\n', 'a', 'aq `x\n#y` b\n'],
    // 改行内代码本身
    ['a `x\n#y` b\n', 'x', 'a `xq\n#y` b\n'],
    // 引用 / 列表里(续行带前缀)
    ['> a `x\n> #y` b\n', 'a', '> aq `x\n> #y` b\n'],
    ['- a `x\n  #y` b\n- c\n', 'b', '- a `x\n  #y` bq\n- c\n'],
    // CRLF
    ['a $b `$c` x  \r\n[y](u) `z`\r\n', 'a', 'aq $b `$c` x  \r\n[y](u) `z`\r\n'],
  ];
  for (const [doc, needle, expected] of cases) {
    it(`${JSON.stringify(doc)} 改「${needle}」:只多一个字,其余字节不变`, async () => {
      const { crepe, view } = await open(doc);
      expect(crepe.getMarkdown()).toBe(doc);
      typeAfter(view, needle, 'q');
      expect(crepe.getMarkdown()).toBe(expected);
    });
  }

  it('删一个字同样只少那一个字', async () => {
    const doc = 'a $b `$c` xy  \n[y](u) `z`\n';
    const { crepe, view } = await open(doc);
    const pos = posAfter(view, 'x');
    view.dispatch(view.state.tr.delete(pos, pos + 1));
    expect(crepe.getMarkdown()).toBe('a $b `$c` x  \n[y](u) `z`\n');
  });

  it('改动会改变解析结果(输入反引号):不照原文拼接,输出解析回来与编辑后的文档相同', async () => {
    const doc = 'a `x\n#y` b\n';
    const { crepe, view } = await open(doc);
    typeAfter(view, 'a', '`');
    const out = crepe.getMarkdown();
    const parsed = crepe.editor.ctx.get<(md: string) => PmNode, 'parser'>('parser')(out);
    expect(sameBlock(parsed.child(0), view.state.doc.child(0)), out).toBe(true);
  });

  // 结构编辑模糊测试 seed 99 第 615 轮(最小化):拆段后两段整段走 remark,remark 把跨行行内代码里的换行写成空格,
  // 行内代码的内容变了(`$PATH `$` 公式吞反引号错配出的跨行行内代码同理)
  for (const doc of ['ab `x\n#y` z\n', 'ab $P `$H` t $x$ \\\n[x](u) `d`\n'] as const) {
    it(`${JSON.stringify(doc)} 在「a|b」处拆段:新段里跨行的行内代码保留换行,解析回来与编辑后的文档相同`, async () => {
      const { crepe, view } = await open(doc);
      view.dispatch(view.state.tr.split(posAfter(view, 'a')));
      const out = crepe.getMarkdown();
      const parsed = topBlocks(crepe.editor.ctx.get<(md: string) => PmNode, 'parser'>('parser')(out));
      const edited = topBlocks(view.state.doc);
      expect(parsed.length, out).toBe(2);
      parsed.forEach((node, i) => expect(sameBlock(node, edited[i]!), `块 ${i}:\n${JSON.stringify(out)}`).toBe(true));
    });
  }
  it('拆段:跨行的行内代码按原样换行写出', async () => {
    const { crepe, view } = await open('ab `x\n#y` z\n');
    view.dispatch(view.state.tr.split(posAfter(view, 'a')));
    expect(crepe.getMarkdown()).toBe('a\n\nb `x\n#y` z\n');
  });
});

describe('硬换行前是空白(`a \\` 写法)、全文硬换行是行尾两空格', () => {
  // 第五十轮模糊测试:按行尾两空格写 `cd ` 后的硬换行 → `cd   ` 三个空格,解析回来 `cd` 后的空格没了(紧跟裸链接时同样)
  for (const [tail, expected] of [
    ['z', 'b cd \\\nz'],
    ['https://b.com/p', 'b cd \\\nhttps://b.com/p'],
  ] as const) {
    it(`拆段后新段走 remark:硬换行写成 \\,空格保留(下一行 ${tail})`, async () => {
      const { crepe, view } = await open(`x  \ny\n\nab cd \\\n${tail}\n`);
      view.dispatch(view.state.tr.split(posAfter(view, 'ab') - 1));
      expect(crepe.getMarkdown()).toBe(`x  \ny\n\na\n\n${expected}\n`);
    });
  }
});

describe('同步 / 重建', () => {
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

  it('MilkdownEditor:CRLF 文档改一处,卸载回写的全文仍是 CRLF、只差那一行', async () => {
    const crlf = FIXTURE.replace(/\n/g, '\r\n');
    const onWriteBack = vi.fn();
    const { unmount } = render(<MilkdownEditor tabId="/t.md" defaultValue={crlf} onWriteBack={onWriteBack} />);
    const crepe = await waitMounted();
    typeAfter(crepe.editor.ctx.get<EditorView, 'editorView'>('editorView'), 'item', 'Z');
    unmount();
    expect(onWriteBack).toHaveBeenCalledTimes(1);
    expect(changedLines(crlf, onWriteBack.mock.calls[0]![0] as string)).toEqual(['33: "* item\\r" → "* itemZ\\r"']);
  });

  it('状态栏改行尾(外部内容同步成 LF / CRLF)后,编辑模式的保存按新行尾写,未改动的块仍原样', async () => {
    const lf = '# T\n\n|a|b|\n|-|-|\n|1|2|\n\npara\n';
    const onWriteBack = vi.fn();
    const { rerender, unmount } = render(
      <MilkdownEditor tabId="/t.md" defaultValue={lf} value={lf} onWriteBack={onWriteBack} />,
    );
    const crepe = await waitMounted();
    const crlf = lf.replace(/\n/g, '\r\n');
    rerender(<MilkdownEditor tabId="/t.md" defaultValue={lf} value={crlf} onWriteBack={onWriteBack} />);
    typeAfter(crepe.editor.ctx.get<EditorView, 'editorView'>('editorView'), 'para', 'Z');
    unmount();
    expect(onWriteBack.mock.calls[0]![0]).toBe('# T\r\n\r\n|a|b|\r\n|-|-|\r\n|1|2|\r\n\r\nparaZ\r\n');
  });
});

describe('工具函数', () => {
  it('表格行按未转义的 | 拆分', () => {
    expect(splitTableRow('| a | b \\| c | `x` |')).toEqual(['a', 'b \\| c', '`x`']);
    expect(splitTableRow('a|b')).toEqual(['a', 'b']);
    expect(splitTableRow('|  | b |')).toEqual(['', 'b']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 模糊测试:随机文档 + 随机单处编辑 → 被编辑块之外的字节不变,且输出解析回来与编辑后的文档相同

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'snake_case', '2 * 3', '中文', 'x'];
const INLINE = [
  (w: string) => w,
  (w: string) => `*${w}*`,
  (w: string) => `**${w}**`,
  (w: string) => `\`${w}\``,
  (w: string) => `[${w}](https://ex.com/${w.length})`,
  () => 'https://bare.example.com/p.',
  () => '[x]',
  () => '$5 and $10',
  () => '$x^2$',
  () => '`$HOME` then $PATH',
];

function sentence(r: () => number): string {
  const n = 1 + Math.floor(r() * 4);
  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const w = WORDS[Math.floor(r() * WORDS.length)]!;
    parts.push(INLINE[Math.floor(r() * INLINE.length)]!(w));
  }
  return parts.join(' ');
}

const BLOCKS: ReadonlyArray<(r: () => number) => string> = [
  (r) => `# ${sentence(r)}`,
  (r) => `${sentence(r)}\n===`,
  (r) => sentence(r),
  (r) => `${sentence(r)}  \n${sentence(r)}`,
  // 反斜杠前留空格:裸链接紧跟 `\` 时 GFM 把 `\` 算进链接(与原样写回无关)
  (r) => `${sentence(r)} \\\n${sentence(r)}`,
  (r) => `- ${sentence(r)}\n- ${sentence(r)}`,
  (r) => `* ${sentence(r)}\n* ${sentence(r)}\n  * ${sentence(r)}`,
  // 有序列表项不以 `[x]` 开头:那是有序任务项,Milkdown 序列化本就丢勾选框(与原样写回无关)
  (r) => `1. w ${sentence(r)}\n1. w ${sentence(r)}`,
  (r) => `3) w ${sentence(r)}\n4) w ${sentence(r)}`,
  (r) => `- [ ] ${sentence(r)}\n- [x] ${sentence(r)}`,
  (r) => `| h1 | h2 |\n|---|---|\n| ${sentence(r)} | c |`,
  (r) => `h1 | h2\n:--|--:\n${sentence(r)} | c`,
  (r) => `|h|i|\n|:-:|-|\n|${sentence(r)}|d|`,
  () => '| Name | Value |\n| ---- | ----- |\n| a    | 1     |',
  (r) => `> ${sentence(r)}\n> ${sentence(r)}`,
  () => '```js\nconst a = 1;\n```',
  () => '~~~\nplain\n~~~',
  () => '***',
  () => '* * *',
  () => '<div>html block</div>',
  () => '$$\nx^2\n$$',
];

/** 没闭合的围栏代码块(只能是最后一块)。 */
const UNCLOSED_FENCE = '```js\nconst open = 1;';

interface Edit {
  readonly pos: number;
  readonly del: boolean;
  /** 被编辑的顶层块下标(不计空段落)。 */
  readonly block: number;
}

/**
 * 随机挑一处文字:插入一个字母或删掉一个字。只删两侧都不是空白的字(删出标记里首尾的空白时 Milkdown 序列化会把空白挪出
 * 标记,与原样写回无关)。
 */
function randomEdit(doc: PmNode, r: () => number): Edit | null {
  const spots: Array<{ pos: number; text: string; block: number }> = [];
  let block = -1;
  doc.forEach((child, offset) => {
    if (child.type.name === 'paragraph' && child.childCount === 0) return;
    block += 1;
    const b = block;
    child.descendants((node, p) => {
      if (node.isText && node.text) spots.push({ pos: offset + 1 + p, text: node.text, block: b });
      return true;
    });
  });
  if (spots.length === 0) return null;
  const spot = spots[Math.floor(r() * spots.length)]!;
  const len = spot.text.length;
  if (len > 2 && r() < 0.3) {
    const i = 1 + Math.floor(r() * (len - 2));
    if (!/\s/.test(spot.text[i - 1]! + spot.text[i]! + spot.text[i + 1]!)) return { pos: spot.pos + i, del: true, block: spot.block };
  }
  const at = Math.floor(r() * (len + 1));
  // 不插在 CRLF 的 CR 与 LF 之间(CRLF 文档的代码块文字里带 `\r\n`;光标到不了那里)
  return { pos: spot.pos + (spot.text[at - 1] === '\r' ? at - 1 : at), del: false, block: spot.block };
}

interface MdPos {
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
  readonly type: string;
}

/** 段落里可拆分的位置(相对段落正文):无标记文字里两个字母之间。 */
function splitPoints(paragraph: PmNode): number[] {
  const out: number[] = [];
  paragraph.forEach((node, offset) => {
    if (!node.isText || node.marks.length > 0) return;
    const text = node.text!;
    for (let i = 1; i < text.length; i += 1) if (/\p{L}/u.test(text[i - 1]!) && /\p{L}/u.test(text[i]!)) out.push(offset + i);
  });
  return out;
}

/** 模糊测试每轮收尾:销毁本轮的编辑器并放掉引用(FUZZ_N 上千轮时 instances / DOM 不累积,否则堆溢出)。 */
async function closeLast(): Promise<void> {
  await editors.pop()?.destroy();
  instances.length = 0;
  document.body.innerHTML = '';
}

/** 顶层块(不计空段落)。 */
function topBlocks(doc: PmNode): PmNode[] {
  const list: PmNode[] = [];
  doc.forEach((c) => {
    if (!(c.type.name === 'paragraph' && c.childCount === 0)) list.push(c);
  });
  return list;
}

/**
 * 每轮独立的随机数(种子 + 轮次):失败信息里的 round 可单独重放(FUZZ_FROM=<round> FUZZ_N=1),上千轮也可分段跑
 *(FUZZ_FROM 起 FUZZ_N 轮;jsdom 里 Crepe 销毁后仍有残留,单进程连跑上千轮会堆溢出)。
 */
const FUZZ_FROM = Number(process.env.FUZZ_FROM ?? 0);
function roundRng(seed: number, round: number): () => number {
  return rng(Math.imul(seed, 100_003) + round);
}

describe('模糊测试', () => {
  it('随机文档 × 随机单处编辑:被编辑块之外逐字节不变,输出解析回来与编辑后的文档相同', async () => {
    // FUZZ_SEED / FUZZ_N / FUZZ_FROM:本地加大轮数找问题(默认固定种子 60 轮)
    const rounds = Number(process.env.FUZZ_N ?? 60);
    const seed = Number(process.env.FUZZ_SEED ?? 20261127);
    let r = rng(seed);
    let checked = 0;
    for (let round = FUZZ_FROM; round < FUZZ_FROM + rounds; round += 1) {
      r = roundRng(seed, round);
      const n = 2 + Math.floor(r() * 6);
      const blocks: string[] = [];
      for (let i = 0; i < n; i += 1) blocks.push(BLOCKS[Math.floor(r() * BLOCKS.length)]!(r));
      const unclosed = r() < 0.2;
      if (unclosed) blocks.push(UNCLOSED_FENCE);
      const eol = r() < 0.3 ? '\r\n' : '\n';
      const tail = ['', '\n', '\n\n\n'][Math.floor(r() * 3)]!;
      const source = (blocks.map((b, i) => (i === 0 ? '' : r() < 0.2 ? '\n\n\n' : '\n\n') + b).join('') + tail).replace(
        /\n/g,
        eol,
      );
      const { crepe, view } = await open(source);
      const label = `round ${round}: ${JSON.stringify(source)}`;
      expect(crepe.getMarkdown(), label).toBe(source);
      const edit = randomEdit(view.state.doc, r);
      if (!edit) {
        await closeLast();
        continue;
      }
      view.dispatch(edit.del ? view.state.tr.delete(edit.pos, edit.pos + 1) : view.state.tr.insertText('q', edit.pos));
      const out = crepe.getMarkdown();
      // 被编辑块在原文里的区间(同一 remark 解析;顶层块与 ProseMirror 顶层节点一一对应)
      const remark = crepe.editor.ctx.get<{ parse(s: string): unknown; runSync(t: unknown, f?: string): unknown }, 'remark'>('remark');
      const tree = remark.runSync(remark.parse(source), source) as { children: MdPos[] };
      const kids = tree.children.filter((c) => c.type !== 'definition');
      const target = kids[edit.block]!;
      const from = target.position!.start.offset!;
      const to = target.position!.end.offset!;
      expect(out.startsWith(source.slice(0, from)), `${label}\n前缀变了:\n${out}`).toBe(true);
      // 文末没闭合的围栏:前面紧挨着的列表被改动时它随列表走 remark、补上闭合(既有规则),后缀不再逐字节相同;只查文末换行与解析结果
      if (!unclosed) expect(out.endsWith(source.slice(to)), `${label}\n后缀变了:\n${out}`).toBe(true);
      if (source.endsWith(eol)) expect(out.endsWith(eol), `${label}\n文末换行丢了:\n${JSON.stringify(out)}`).toBe(true);
      if (eol === '\r\n') expect(out.replace(/\r\n/g, ''), label).not.toContain('\n');
      // 输出按同一解析器解析回来,顶层块逐个与编辑后的文档相同
      const parsed = crepe.editor.ctx.get<(md: string) => PmNode, 'parser'>('parser')(out);
      const strip = (doc: PmNode): PmNode[] => {
        const list: PmNode[] = [];
        doc.forEach((c) => {
          if (!(c.type.name === 'paragraph' && c.childCount === 0)) list.push(c);
        });
        return list;
      };
      const a = strip(parsed);
      const b = strip(view.state.doc);
      expect(a.length, `${label}\n${out}`).toBe(b.length);
      a.forEach((node, i) => expect(sameBlock(node, b[i]!), `${label}\n块 ${i} 不同:\n${out}`).toBe(true));
      checked += 1;
      await closeLast();
    }
    // 重放单轮(FUZZ_N 很小)时不查比例
    if (rounds >= 20) expect(checked).toBeGreaterThan(rounds * 0.6);
  }, 600_000);

  it('定向:裸链接 + 含 `$` 的行内代码 + 硬换行 + `$` 混在多行段落 / 引用 / 列表里,随机插一个字:输出只比原文多那一个字', async () => {
    // 这类组合让 `$…$` 吞掉反引号、行内代码跨行(第五十轮);默认 40 轮,FUZZ_N / FUZZ_SEED 可加大
    const rounds = Number(process.env.FUZZ_N ?? 40);
    const seed = Number(process.env.FUZZ_SEED ?? 50) + 2;
    let r = rng(seed);
    const PIECES = ['https://bare.example.com/p.', '`$HOME`', 'then', '$PATH', '$10', '$5 and', '`alpha`', '[delta](https://ex.com/5)', '#y', '[y](u)', '*em*', '$x$', '`a b`'];
    const BREAKS = ['  \n', ' \\\n', '\n'];
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
    const lines = (): string[] => {
      const out: string[] = [];
      for (let i = 1 + Math.floor(r() * 3); i >= 0; i -= 1) {
        const parts: string[] = [];
        for (let j = 1 + Math.floor(r() * 4); j >= 0; j -= 1) parts.push(pick(PIECES));
        out.push(parts.join(' '));
      }
      return out;
    };
    const joined = (ls: readonly string[], prefix: string): string =>
      ls.map((l, i) => (i === 0 ? l : prefix + l)).reduce((acc, l) => acc + pick(BREAKS) + l);
    const BLOCK = [
      () => joined(lines(), ''),
      () => `> ${joined(lines(), '> ')}`,
      () => `- ${joined(lines(), '  ')}\n- tail`,
    ];
    let strict = 0;
    for (let round = FUZZ_FROM; round < FUZZ_FROM + rounds; round += 1) {
      r = roundRng(seed, round);
      const blocks: string[] = [];
      for (let i = 1 + Math.floor(r() * 3); i > 0; i -= 1) blocks.push(pick(BLOCK)());
      const eol = r() < 0.3 ? '\r\n' : '\n';
      const source = `${blocks.join('\n\n')}\n`.replace(/\n/g, eol);
      const { crepe, view } = await open(source);
      const label = `round ${round}: ${JSON.stringify(source)}`;
      expect(crepe.getMarkdown(), label).toBe(source);
      const edit = randomEdit(view.state.doc, r);
      if (!edit) {
        await closeLast();
        continue;
      }
      const pos = edit.pos;
      view.dispatch(view.state.tr.insertText('q', pos));
      const out = crepe.getMarkdown();
      const parse = crepe.editor.ctx.get<(md: string) => PmNode, 'parser'>('parser');
      const a = topBlocks(parse(out));
      const b = topBlocks(view.state.doc);
      expect(a.length, `${label}\n${out}`).toBe(b.length);
      a.forEach((node, i) => expect(sameBlock(node, b[i]!), `${label}\n块 ${i} 不同:\n${out}`).toBe(true));
      // 原文某处插一个 q 就能解析成编辑后的文档 → 输出必须正是这样(只多一个 q);否则(挨着裸链接打字改了自动链接的范围、
      // q 让两个 `$` 配成公式……)只要求解析回来相同
      const isOneInsert = out.length === source.length + 1 && (() => {
        const at = Array.from(out).findIndex((ch, i) => ch !== source[i]);
        return out.slice(0, at) + out.slice(at + 1) === source;
      })();
      if (isOneInsert) strict += 1;
      else {
        for (let i = 0; i <= source.length; i += 1) {
          const candidate = source.slice(0, i) + 'q' + source.slice(i);
          const c = topBlocks(parse(candidate));
          const ok = c.length === b.length && c.every((node, k) => sameBlock(node, b[k]!));
          expect(ok, `${label}\n在原文第 ${i} 个字符处插 q 即可,却输出:\n${JSON.stringify(out)}`).toBe(false);
        }
      }
      await closeLast();
    }
    // 重放单轮(FUZZ_N 很小)时不查比例
    if (rounds >= 20) expect(strict).toBeGreaterThan(rounds * 0.5);
  }, 600_000);

  it('随机文档 × 随机结构编辑(删块 / 移块 / 拆段 / 新段):输出解析回来与编辑后的文档相同', async () => {
    const rounds = Number(process.env.FUZZ_N ?? 60);
    const seed = Number(process.env.FUZZ_SEED ?? 7) + 1;
    let r = rng(seed);
    for (let round = FUZZ_FROM; round < FUZZ_FROM + rounds; round += 1) {
      r = roundRng(seed, round);
      const n = 3 + Math.floor(r() * 5);
      const blocks: string[] = [];
      for (let i = 0; i < n; i += 1) blocks.push(BLOCKS[Math.floor(r() * BLOCKS.length)]!(r));
      // 最后一块有时是没闭合的围栏(延伸到文末,区间吞掉文末换行)
      if (r() < 0.25) blocks.push(UNCLOSED_FENCE);
      const eol = r() < 0.3 ? '\r\n' : '\n';
      const source = `${blocks.join('\n\n')}\n`.replace(/\n/g, eol);
      const { crepe, view } = await open(source);
      const label = `round ${round}: ${JSON.stringify(source)}`;
      const doc = view.state.doc;
      const offsets: number[] = [];
      doc.forEach((_c, offset) => offsets.push(offset));
      const k = Math.floor(r() * doc.childCount);
      const child = doc.child(k);
      const at = offsets[k]!;
      const op = Math.floor(r() * 4);
      const { schema } = view.state;
      if (op === 0 && doc.childCount > 1) view.dispatch(view.state.tr.delete(at, at + child.nodeSize));
      else if (op === 1) {
        const target = offsets[Math.floor(r() * doc.childCount)]!;
        const tr = view.state.tr.delete(at, at + child.nodeSize);
        tr.insert(tr.mapping.map(target), child);
        view.dispatch(tr);
      } else if (op === 2 && child.type.name === 'paragraph' && splitPoints(child).length > 0) {
        // 在无标记文字的两个字母之间拆(拆出段首段尾空白 / 拆开标记时 Milkdown 序列化本就规范化空白,与原样写回无关)
        const points = splitPoints(child);
        view.dispatch(view.state.tr.split(at + 1 + points[Math.floor(r() * points.length)]!));
      } else {
        view.dispatch(view.state.tr.insert(at, schema.nodes.paragraph!.create(null, schema.text('new para'))));
      }
      const out = crepe.getMarkdown();
      // 原文以换行结尾 → 输出也是(行尾同原文)
      expect(out.endsWith(eol), `${label}\n文末换行丢了:\n${JSON.stringify(out)}`).toBe(true);
      if (eol === '\r\n') expect(out.replace(/\r\n/g, ''), label).not.toContain('\n');
      const parsed = crepe.editor.ctx.get<(md: string) => PmNode, 'parser'>('parser')(out);
      const strip = (d: PmNode): PmNode[] => {
        const list: PmNode[] = [];
        d.forEach((c) => {
          if (!(c.type.name === 'paragraph' && c.childCount === 0)) list.push(c);
        });
        return list;
      };
      const a = strip(parsed);
      const b = strip(view.state.doc);
      expect(a.length, `${label}\n${out}`).toBe(b.length);
      a.forEach((node, i) => expect(sameBlock(node, b[i]!), `${label}\n块 ${i} 不同:\n${out}`).toBe(true));
      await closeLast();
    }
  }, 600_000);
});
