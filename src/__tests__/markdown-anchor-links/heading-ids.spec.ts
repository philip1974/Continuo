// @vitest-environment jsdom
// 真实 Crepe(不 mock):编辑 / 预览渲染出的标题 id 与 `#片段` 解析用的 slug 同一套规则(见同目录 README)。
import { afterEach, describe, expect, it } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { installGithubHeadingIds } from '@/panels/Editor/markdown-heading-id';
import { markdownHeadings } from '@/panels/Editor/markdown-fragment';

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

  it('编辑后标题改名:id 随之重算,重复后缀按新顺序重排', async () => {
    const { crepe, root } = await open('# A\n\n# B\n');
    expect(renderedIds(root)).toEqual(['a', 'b']);
    const view = crepe.editor.ctx.get<import('@milkdown/kit/prose/view').EditorView, 'editorView'>('editorView');
    // 第二个标题文字 B → A
    let pos = -1;
    view.state.doc.descendants((n, p) => {
      if (n.type.name === 'heading' && n.textContent === 'B') pos = p;
      return true;
    });
    view.dispatch(view.state.tr.insertText('A', pos + 1, pos + 2));
    expect(renderedIds(root)).toEqual(['a', 'a-1']);
  });
});
