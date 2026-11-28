// @vitest-environment jsdom
// 真实 Crepe(不 mock):编辑 / 预览渲染出的标题 id 与 `#片段` 解析用的 slug 同一套规则(见同目录 README)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { undo } from '@milkdown/kit/prose/history';
import type { Transaction } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { HEADING_ID_SYNC_DELAY_MS, installGithubHeadingIds } from '@/panels/Editor/markdown-heading-id';
import { markdownHeadings } from '@/panels/Editor/markdown-fragment';
import * as slug from '@/panels/Editor/markdown-heading-slug';

// 透传,只为数「重算全部标题 id」的次数(每次重算新建一个 slug 构造器)。
vi.mock('@/panels/Editor/markdown-heading-slug', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/panels/Editor/markdown-heading-slug')>();
  return { ...real, createSlugBuilder: vi.fn(real.createSlugBuilder) };
});

const editors: Crepe[] = [];

async function open(markdown: string, readonly = false): Promise<{ crepe: Crepe; root: HTMLElement }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({
    root,
    defaultValue: markdown,
    features: { [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.Latex]: false },
  });
  installGithubHeadingIds(crepe.editor);
  if (readonly) crepe.setReadonly(true);
  editors.push(crepe);
  await crepe.create();
  return { crepe, root };
}

const renderedIds = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('.ProseMirror :is(h1,h2,h3,h4,h5,h6)')].map((h) => h.id);

afterEach(async () => {
  for (const crepe of editors.splice(0)) await crepe.destroy();
  document.body.innerHTML = '';
});

const DOC = [
  '# Install',
  '',
  '## 安装 指南',
  '',
  '## Install',
  '',
  '## Install',
  '',
  '### Hello, World! 🎉',
  '',
  '## API `foo_bar()` & *more*',
  '',
  '## [Link text](https://example.com) and ![img](a.png)',
  '',
  '## snake_case _emphasis_ \\_escaped\\_',
  '',
  'Setext Title',
  '============',
  '',
  '```md',
  '# not a heading',
  '```',
  '',
  '> ## Quoted',
  '',
  '## Ⅻ roman ²',
  '',
].join('\n');

describe('渲染出的标题 id 与解析用的 slug 一致', () => {
  it.each([false, true])('readonly=%s:每个标题的 id = 源码解析出的 slug(中文 / 重复 / emoji / 标点 / 行内标记)', async (ro) => {
    const { root } = await open(DOC, ro);
    const expected = markdownHeadings(DOC).map((h) => h.slug);
    expect(expected).toEqual([
      'install',
      '安装-指南',
      'install-1',
      'install-2',
      'hello-world-',
      'api-foo_bar--more',
      'link-text-and',
      'snake_case-emphasis-_escaped_',
      'setext-title',
      'quoted',
      'ⅻ-roman-',
    ]);
    expect(renderedIds(root)).toEqual(expected);
  });

  it('更多写法:列表里的标题、实体、行内 HTML、删除线、多行 setext、frontmatter 之后', async () => {
    const doc = [
      '- ## In list',
      '',
      '## A &amp; B &#169;',
      '',
      '## <span>html</span> tag',
      '',
      '## ~~old~~ new',
      '',
      'Multi',
      'line',
      '----',
      '',
    ].join('\n');
    const { root } = await open(doc);
    const expected = markdownHeadings(doc).map((h) => h.slug);
    expect(expected).toEqual(['in-list', 'a--b-', 'html-tag', 'old-new', 'multiline']);
    expect(renderedIds(root)).toEqual(expected);
  });

  it('编辑后标题改名:停手后 id 随之重算,重复后缀按新顺序重排', async () => {
    const { crepe, root } = await open('# A\n\n# B\n');
    expect(renderedIds(root)).toEqual(['a', 'b']);
    const view = editorView(crepe);
    // 第二个标题文字 B → A
    const pos = headingPos(view, 'B');
    view.dispatch(view.state.tr.insertText('A', pos + 1, pos + 2));
    await vi.waitFor(() => expect(renderedIds(root)).toEqual(['a', 'a-1']));
  });
});

const editorView = (crepe: Crepe): EditorView => crepe.editor.ctx.get<EditorView, 'editorView'>('editorView');

function headingPos(view: EditorView, text: string): number {
  let pos = -1;
  view.state.doc.descendants((n, p) => {
    if (n.type.name === 'heading' && n.textContent === text) pos = p;
    return true;
  });
  return pos;
}

/** 记录之后经 view.dispatch 派发的事务(本插件 / 其它插件的同步事务都走它)。 */
function recordDispatches(view: EditorView): Transaction[] {
  const seen: Transaction[] = [];
  const orig = view.dispatch.bind(view);
  view.dispatch = (tr: Transaction) => {
    seen.push(tr);
    orig(tr);
  };
  return seen;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('标题 id 同步的开销(低配 / 电池:打字不额外派发全文事务)', () => {
  const BIG = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\nParagraph ${i} with *some* text.\n`).join('\n');

  it('Milkdown 自带的 syncHeadingIdPlugin 已摘除(只剩本插件同步,不再每键多遍历一次全文)', async () => {
    const { crepe } = await open(BIG);
    const keys = editorView(crepe).state.plugins.map((p) => (p as unknown as { key: string }).key);
    expect(keys.some((k) => k.startsWith('MILKDOWN_HEADING_ID'))).toBe(false);
  });

  it('正文里打字:不重算标题 id、不派发任何 id 同步事务', async () => {
    const { crepe } = await open(BIG);
    const view = editorView(crepe);
    const seen = recordDispatches(view);
    const rebuilds = vi.mocked(slug.createSlugBuilder);
    rebuilds.mockClear();
    let pos = -1;
    view.state.doc.descendants((n, p) => {
      if (pos < 0 && n.type.name === 'paragraph' && n.textContent.startsWith('Paragraph 3')) pos = p;
      return pos < 0;
    });
    for (const ch of 'abc') view.dispatch(view.state.tr.insertText(ch, pos + 1));
    await wait(HEADING_ID_SYNC_DELAY_MS * 2);
    expect(seen).toHaveLength(3);
    expect(rebuilds).not.toHaveBeenCalled();
  });

  it('标题里连续打字:每键不额外派发;停手后只派发一次 id 事务,且不进撤销历史', async () => {
    const { crepe, root } = await open(BIG);
    const view = editorView(crepe);
    const seen = recordDispatches(view);
    for (const ch of 'xyz') {
      const pos = headingPos(view, view.state.doc.child(0).textContent);
      view.dispatch(view.state.tr.insertText(ch, pos + 1 + view.state.doc.child(0).content.size));
    }
    expect(seen).toHaveLength(3);
    await vi.waitFor(() => expect(renderedIds(root)[0]).toBe('section-0xyz'));
    expect(seen).toHaveLength(4);
    expect(seen[3]!.getMeta('addToHistory')).toBe(false);
    // 撤销只撤用户的输入(id 事务不在撤销栈里),之后 id 随文字回到原值
    while (undo(view.state, view.dispatch)) {
      /* 撤到底 */
    }
    expect(view.state.doc.child(0).textContent).toBe('Section 0');
    await vi.waitFor(() => expect(renderedIds(root)[0]).toBe('section-0'));
  });
});
