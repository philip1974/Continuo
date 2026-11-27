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

    // 第五十一轮审计 A2:链接后接全角标点 —— 链接与 GFM 解析保存结果的认定一致,保存时原文不变(不转义 `:` / `.`)
    it('裸链接后接全角标点「。」「，」→ 链接同 GFM(micromark)认定,保存原样、不转义', async () => {
      for (const [md, url, punct] of [
        ['Para with https://example.com bare.\n', 'https://example.com', '。'],
        ['Para with https://example.com bare.\n', 'https://example.com', '，'],
        ['See www.example.com now.\n', 'www.example.com', '。'],
      ] as const) {
        const { crepe, view } = await open(md, verbatim);
        typeAfter(view, url, punct);
        const out = crepe.getMarkdown();
        expect(out).toBe(md.replace(url, url + punct));
        expect(links(view)).toEqual(await savedLinks(out));
      }
    });

    // 第五十一轮审计 A4:续写 `.cn` / `?q=1`(逐键输入:先打的 `.` / `?` 一度是句末标点)→ 链接随后续字符延长,保存仍是裸链接
    it('续写 `.cn`、`?q=1`、邮箱 `.cn` → 地址跟随整段,保存为裸链接(不变成 `<url>`)', async () => {
      const a = await open(PARA, verbatim);
      typeKeys(a.view, 'https://example.com', '.cn');
      expect(links(a.view)).toEqual([['https://example.com.cn', 'https://example.com.cn']]);
      expect(a.crepe.getMarkdown()).toBe('Para with https://example.com.cn bare.\n');
      const b = await open(PARA, verbatim);
      typeKeys(b.view, 'https://example.com', '/p?q=1');
      expect(links(b.view)).toEqual([['https://example.com/p?q=1', 'https://example.com/p?q=1']]);
      expect(b.crepe.getMarkdown()).toBe('Para with https://example.com/p?q=1 bare.\n');
      const c = await open('Mail a@example.com now.\n', verbatim);
      typeKeys(c.view, 'a@example.com', '.cn');
      expect(links(c.view)).toEqual([['a@example.com.cn', 'mailto:a@example.com.cn']]);
      expect(c.crepe.getMarkdown()).toBe('Mail a@example.com.cn now.\n');
      // 中途停在标点处:标点仍是普通文字(GFM 不算进链接),保存原样
      const d = await open(PARA, verbatim);
      typeKeys(d.view, 'https://example.com', '/p?');
      expect(links(d.view)).toEqual([['https://example.com/p', 'https://example.com/p']]);
      expect(d.crepe.getMarkdown()).toBe('Para with https://example.com/p? bare.\n');
      // 只有尖括号才成立的(`<url>` 后紧跟文字):不把后面的文字并进链接
      const e = await open('See <https://example.com>abc now.\n', verbatim);
      typeAfter(e.view, 'https://example.com', '/p');
      expect(links(e.view)).toEqual([['https://example.com/p', 'https://example.com/p']]);
      expect(e.crepe.getMarkdown()).toBe('See <https://example.com/p>abc now.\n');
    });

    // 第五十一轮审计 A3:输入法组字期间不改文档,组字结束后补判
    it('输入法在链接末尾组字「中文」→ 组字期间不动,结束后地址跟随,保存为裸链接', async () => {
      for (const flush of ['compositionend', 'next-transaction'] as const) {
        const { crepe, view } = await open(PARA, verbatim);
        const at = posAfter(view, 'https://example.com');
        view.dispatch(view.state.tr.insertText('zhong', at).setMeta('composition', 1));
        view.dispatch(view.state.tr.insertText('中文', at, at + 5).setMeta('composition', 1));
        // 组字期间:地址不动(不改 mark)
        expect(links(view)).toEqual([['https://example.com中文', 'https://example.com']]);
        if (flush === 'compositionend') {
          view.dom.dispatchEvent(new Event('compositionend'));
          await new Promise((r) => setTimeout(r, 100));
        } else {
          view.dispatch(view.state.tr.setSelection(view.state.selection));
        }
        expect(links(view)).toEqual([['https://example.com中文', 'https://example.com中文']]);
        const out = crepe.getMarkdown();
        expect(out).toBe('Para with https://example.com中文 bare.\n');
        expect(links(view)).toEqual(await savedLinks(out));
      }
    });
  });
}

/** 逐键输入(每个字符一次事务,同真实打字)。 */
function typeKeys(view: EditorView, needle: string, text: string): void {
  let pos = posAfter(view, needle);
  for (const ch of text) {
    view.dispatch(view.state.tr.insertText(ch, pos));
    pos += ch.length;
  }
}

/** 保存结果重新打开后的链接(= GFM 解析保存结果的认定)。 */
async function savedLinks(markdown: string): Promise<[string, string][]> {
  const { view } = await open(markdown);
  return links(view);
}

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

// 第五十一轮审计 A2 / A3 / A4:链接附近随机逐键输入 / 删字后,编辑器里的链接与保存结果重新打开后的链接(GFM 认定)一致,文字不变
//(没有多出的转义、没有变成别的写法而丢字)。FUZZ_N / FUZZ_FROM / FUZZ_SEED 分段加大轮数(jsdom 每轮有残留)。
describe('模糊测试:链接附近随机编辑', () => {
  const DOCS = [
    'Para with https://example.com bare.\n',
    'See www.example.com now.\n',
    'Mail a@example.com now.\n',
    'Go https://example.com/p\n',
    '(see https://example.com/a)\n',
  ];
  const CHARS = ['.', '?', '。', '，', 'c', 'n', '/', ' ', ')', '(', '中', '=', '1', '-', ',', '!', ':', '#'];
  it('编辑器里的链接 = 保存结果解析回来的链接,文字一致', async () => {
    const rounds = Number(process.env.FUZZ_N ?? 30);
    const from = Number(process.env.FUZZ_FROM ?? 0);
    const seed = Number(process.env.FUZZ_SEED ?? 51);
    for (let round = from; round < from + rounds; round += 1) {
      const r = rng(Math.imul(seed, 100_003) + round);
      const md = DOCS[Math.floor(r() * DOCS.length)]!;
      const verbatim = r() < 0.5;
      const { crepe, view } = await open(md, verbatim);
      const start = posAfter(view, md.includes('Mail') ? 'Mail ' : md.split(/https|www/)[0]!);
      const ops: string[] = [];
      // 每轮只插字或只删字;链接整个去掉后本轮停止 —— 之后再编辑使普通文字重新成为链接形状(先插字打断、再删掉它)不在本规范范围:
      // 普通文字不随编辑自动加链接(只有编辑前就是自动链接的才跟随)
      const inserting = r() < 0.7;
      for (let k = 1 + Math.floor(r() * 6); k > 0 && links(view).length > 0; k -= 1) {
        const pos = Math.min(view.state.doc.content.size - 1, start - 1 + Math.floor(r() * 26));
        if (inserting) {
          const ch = CHARS[Math.floor(r() * CHARS.length)]!;
          ops.push(`+${pos}${ch}`);
          view.dispatch(view.state.tr.insertText(ch, pos));
        } else if (pos > 1) {
          ops.push(`-${pos}`);
          view.dispatch(view.state.tr.delete(pos - 1, pos));
        }
      }
      const out = crepe.getMarkdown();
      const reopened = await open(out);
      const ctx = `round ${round} ${verbatim ? 'verbatim' : 'rewrite'} ${JSON.stringify(md)} ${ops.join(' ')} → ${JSON.stringify(out)}`;
      // 段尾空白 Markdown 本来就不保留
      expect(reopened.view.state.doc.textContent, ctx).toBe(view.state.doc.textContent.trimEnd());
      expect(links(reopened.view), ctx).toEqual(links(view));
      for (const c of editors.splice(0)) await c.destroy();
      document.body.innerHTML = '';
    }
  });
});
