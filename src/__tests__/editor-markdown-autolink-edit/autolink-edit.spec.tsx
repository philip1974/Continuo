// @vitest-environment jsdom
// 真实 Crepe(不 mock):编辑模式里编辑自动链接(裸链接 / `<url>` / www. / 邮箱,文字 = 地址)的文字 → 地址跟随文字,保存结果文字与
// 地址一致;新文字不再是合法链接 → 按 GFM 只把合法开头当链接或去掉链接;`[文字](地址)` 不受影响(第五十轮审计 A2)。
// 就地改原文(configureSourceBlocks)与整块重写(只有 configureMarkdownStyle)两条序列化路径都查。见同目录 README.md。
import { afterEach, describe, expect, it } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { undo } from '@milkdown/kit/prose/history';
import type { EditorView } from '@milkdown/kit/prose/view';
import { configureMarkdownStyle } from '../../panels/Editor/milkdown-markdown-style';
import { configureSourceBlocks } from '../../panels/Editor/milkdown-source-blocks';
import { configureMarkdownMath } from '../../panels/Editor/milkdown-math';
import { markdownWritingKeys } from '../../panels/Editor/milkdown-writing-keys';

const editors: Crepe[] = [];

/** 与 MilkdownEditor 相同的配置;verbatim = false → 不就地改原文(整块重写路径)。 */
async function open(markdown: string, verbatim = true): Promise<{ crepe: Crepe; view: EditorView }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({ root, defaultValue: markdown, features: { [Crepe.Feature.ImageBlock]: false } });
  configureMarkdownStyle(crepe, markdown);
  if (verbatim) configureSourceBlocks(crepe, markdown);
  configureMarkdownMath(crepe);
  crepe.editor.use(markdownWritingKeys);
  editors.push(crepe);
  await crepe.create();
  return { crepe, view: crepe.editor.ctx.get<EditorView, 'editorView'>('editorView') };
}

afterEach(async () => {
  for (const crepe of editors.splice(0)) await crepe.destroy();
  document.body.innerHTML = '';
});

function posAfter(view: EditorView, needle: string): number {
  let pos = -1;
  view.state.doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text!.includes(needle)) pos = p + node.text!.indexOf(needle) + needle.length;
  });
  if (pos < 0) throw new Error(`找不到 ${needle}`);
  return pos;
}

/** 文档里的链接:[文字, 地址](相邻同一链接 mark 的文字合并)。 */
function links(view: EditorView): [string, string][] {
  const out: [string, string][] = [];
  let last: { text: string; href: string; end: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === 'link');
    if (!mark) return;
    const href = mark.attrs.href as string;
    if (last && last.end === pos && last.href === href) {
      last.text += node.text!;
      last.end = pos + node.nodeSize;
      out[out.length - 1] = [last.text, href];
    } else {
      last = { text: node.text!, href, end: pos + node.nodeSize };
      out.push([node.text!, href]);
    }
  });
  return out;
}

/** 在 needle 之后插字(同用户打字:继承该处的 mark,链接 mark 是 inclusive 的)。 */
function typeAfter(view: EditorView, needle: string, text: string): void {
  view.dispatch(view.state.tr.insertText(text, posAfter(view, needle)));
}
function typeAt(view: EditorView, pos: number, text: string): void {
  view.dispatch(view.state.tr.insertText(text, pos));
}
/** 删掉 needle 之后的 n 个字符。 */
function deleteAfter(view: EditorView, needle: string, n: number): void {
  const at = posAfter(view, needle);
  view.dispatch(view.state.tr.delete(at, at + n));
}

const PARA = 'Para with https://example.com bare.\n';

for (const verbatim of [true, false]) {
  describe(verbatim ? '就地改原文' : '整块重写', () => {
    it('URL 末尾接着打字 → 地址跟随,保存成裸链接(审计复现步骤)', async () => {
      const { crepe, view } = await open(PARA, verbatim);
      typeAfter(view, 'https://example.com', '/p');
      expect(links(view)).toEqual([['https://example.com/p', 'https://example.com/p']]);
      expect(crepe.getMarkdown()).toBe('Para with https://example.com/p bare.\n');
    });

    it('URL 中间插字 / 删字 → 地址跟随', async () => {
      const a = await open(PARA, verbatim);
      typeAfter(a.view, 'https://exam', '-x');
      expect(links(a.view)).toEqual([['https://exam-xple.com', 'https://exam-xple.com']]);
      expect(a.crepe.getMarkdown()).toBe('Para with https://exam-xple.com bare.\n');
      const b = await open(PARA, verbatim);
      deleteAfter(b.view, 'https://', 1);
      expect(links(b.view)).toEqual([['https://xample.com', 'https://xample.com']]);
      expect(b.crepe.getMarkdown()).toBe('Para with https://xample.com bare.\n');
    });

    it('链接前紧挨着打字母 → 按 GFM 不再是链接(不写出 `x<https://…>`)', async () => {
      const a = await open(PARA, verbatim);
      typeAt(a.view, posAfter(a.view, 'Para with '), 'x');
      expect(links(a.view)).toEqual([]);
      // 整块重写时 remark 把文字里的 `://` 转义(防止被认作链接),解析回来同样是文字
      const esc = verbatim ? '://' : '\\://';
      expect(a.crepe.getMarkdown()).toBe(`Para with xhttps${esc}example.com bare.\n`);
      // 段首:打的字并进了链接(inclusive)→ 同样去掉链接
      const b = await open('https://example.com bare.\n', verbatim);
      typeAt(b.view, 1, 'x');
      expect(links(b.view)).toEqual([]);
      expect(b.crepe.getMarkdown()).toBe(`xhttps${esc}example.com bare.\n`);
    });

    it('URL 末尾打空格再打字 → 只有空格前的一段是链接', async () => {
      const { crepe, view } = await open(PARA, verbatim);
      typeAfter(view, 'https://example.com', ' more');
      expect(links(view)).toEqual([['https://example.com', 'https://example.com']]);
      expect(crepe.getMarkdown()).toBe('Para with https://example.com more bare.\n');
    });

    it('URL 末尾打句号 → 句号不算进链接(GFM)', async () => {
      const { crepe, view } = await open(PARA, verbatim);
      typeAfter(view, 'https://example.com', '.');
      expect(links(view)).toEqual([['https://example.com', 'https://example.com']]);
      expect(crepe.getMarkdown()).toBe('Para with https://example.com. bare.\n');
    });

    it('删掉协议 → 不再是链接', async () => {
      const { crepe, view } = await open(PARA, verbatim);
      deleteAfter(view, 'Para with ', 'https://'.length);
      expect(links(view)).toEqual([]);
      expect(crepe.getMarkdown()).toBe('Para with example.com bare.\n');
    });

    it('`<url>` 自动链接、www.、邮箱:地址跟随文字', async () => {
      const a = await open('See <https://example.com> now.\n', verbatim);
      typeAfter(a.view, 'https://example.com', '/p');
      expect(links(a.view)).toEqual([['https://example.com/p', 'https://example.com/p']]);
      expect(a.crepe.getMarkdown()).toBe('See <https://example.com/p> now.\n');
      const b = await open('See www.example.com now.\n', verbatim);
      typeAfter(b.view, 'www.example.com', '/p');
      expect(links(b.view)).toEqual([['www.example.com/p', 'http://www.example.com/p']]);
      expect(b.crepe.getMarkdown()).toBe('See www.example.com/p now.\n');
      const c = await open('Mail a@example.com now.\n', verbatim);
      typeAt(c.view, posAfter(c.view, 'Mail ') + 1, 'x');
      expect(links(c.view)).toEqual([['ax@example.com', 'mailto:ax@example.com']]);
      expect(c.crepe.getMarkdown()).toBe('Mail ax@example.com now.\n');
      const d = await open('See <ftp://files.example.com> now.\n', verbatim);
      typeAfter(d.view, 'ftp://files.example.com', '/x');
      expect(links(d.view)).toEqual([['ftp://files.example.com/x', 'ftp://files.example.com/x']]);
      expect(d.crepe.getMarkdown()).toBe('See <ftp://files.example.com/x> now.\n');
    });

    it('文字 ≠ 地址的链接改文字 → 地址不动', async () => {
      const a = await open('See [docs](https://example.com) now.\n', verbatim);
      typeAfter(a.view, 'docs', 'x');
      expect(links(a.view)).toEqual([['docsx', 'https://example.com']]);
      expect(a.crepe.getMarkdown()).toBe('See [docsx](https://example.com) now.\n');
      const b = await open('See [https://a.com](https://b.com) now.\n', verbatim);
      typeAfter(b.view, 'https://a.com', '/p');
      expect(links(b.view)).toEqual([['https://a.com/p', 'https://b.com']]);
    });

    it('撤销 → 文字与地址一起回到原样', async () => {
      const { crepe, view } = await open(PARA, verbatim);
      typeAfter(view, 'https://example.com', '/p');
      undo(view.state, view.dispatch);
      expect(links(view)).toEqual([['https://example.com', 'https://example.com']]);
      expect(crepe.getMarkdown()).toBe(PARA);
    });
  });
}
