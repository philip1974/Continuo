// GitHub slug 规则(对照 VSCode githubSlugifier)、`#片段` 解析、源码模式链接地址提取。见同目录 README。
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { createSlugBuilder, githubSlug } from '@/panels/Editor/markdown-heading-slug';
import { markdownHeadings, resolveMarkdownFragment } from '@/panels/Editor/markdown-fragment';
import { markdownLinkHrefAt } from '@/panels/Editor/codemirror-markdown-links';

describe('githubSlug(VSCode githubSlugifier / github-slugger)', () => {
  it.each([
    ['Install', 'install'],
    ['  Getting Started  ', 'getting-started'],
    ['Hello, World!', 'hello-world'],
    ['C++ & C#', 'c--c'],
    ['安装 指南', '安装-指南'],
    ['日本語の見出し', '日本語の見出し'],
    ['Emoji 🎉 party', 'emoji--party'],
    ['snake_case', 'snake_case'],
    ['a-b—c', 'a-bc'],
    ['Ünïcödé Ⅻ', 'ünïcödé-ⅻ'],
    ['tab\there', 'tabhere'],
    ['中文，标点。', '中文标点'],
  ])('%j → %j', (text, slug) => {
    expect(githubSlug(text)).toBe(slug);
  });

  it('重复标题依次加 -1 / -2;加后缀仍重名时继续递增;空标题不占 slug', () => {
    const add = createSlugBuilder();
    expect(['A', 'A', 'a', 'A-1', '', 'B'].map(add)).toEqual(['a', 'a-1', 'a-2', 'a-1-1', '', 'b']);
  });
});

describe('markdownHeadings:源码里的标题与 slug(与渲染一致的文字)', () => {
  it('ATX / setext / 引用与列表里的标题;代码块与 frontmatter 里的不算', () => {
    const src = [
      '---',
      'title: x',
      '---',
      '# Top',
      '',
      '    # indented code',
      '',
      '```',
      '# not heading',
      '```',
      'Setext',
      '------',
      '> ## Quoted',
      '- ### In list',
      '',
      '## Top ##',
    ].join('\n');
    expect(markdownHeadings(src).map((h) => [h.line, h.slug])).toEqual([
      [4, 'top'],
      [11, 'setext'],
      [13, 'quoted'],
      [14, 'in-list'],
      [16, 'top-1'],
    ]);
  });

  it('行内标记取渲染文字:强调 / 删除线 / 行内代码 / 链接文字 / 去掉图片与 HTML / 转义 / 实体', () => {
    const src = '## *A* ~~b~~ `c_d` [e](http://x) ![img](y.png) <b>f</b> \\_g\\_ &amp; h';
    expect(markdownHeadings(src)[0]!.text).toBe('A b c_d e  f _g_ & h');
  });
});

describe('resolveMarkdownFragment', () => {
  const src = ['# Intro', '', '## 安装', '', '## Intro', ''].join('\n');
  it('标题 slug:不区分大小写、片段 URL 解码、重复标题 -1', () => {
    expect(resolveMarkdownFragment(src, 'intro')).toEqual({ line: 1 });
    expect(resolveMarkdownFragment(src, 'INTRO-1')).toEqual({ line: 5 });
    expect(resolveMarkdownFragment(src, '%E5%AE%89%E8%A3%85')).toEqual({ line: 3 });
    expect(resolveMarkdownFragment(src, '安装')).toEqual({ line: 3 });
  });
  it('行号片段 L10 / L10,5 / 10 / L3-L5(取起点);找不到 → null', () => {
    expect(resolveMarkdownFragment(src, 'L10')).toEqual({ line: 10 });
    expect(resolveMarkdownFragment(src, 'l10,5')).toEqual({ line: 10, column: 5 });
    expect(resolveMarkdownFragment(src, '7')).toEqual({ line: 7 });
    expect(resolveMarkdownFragment(src, 'L3-L5')).toEqual({ line: 3 });
    expect(resolveMarkdownFragment(src, 'L0')).toBeNull();
    expect(resolveMarkdownFragment(src, 'nope')).toBeNull();
    expect(resolveMarkdownFragment(src, '%E0%A4%A')).toBeNull(); // 非法 percent 序列不抛
  });
  it('非 Markdown 文件(headings = false)只认行号:`# 注释` 不当标题', () => {
    expect(resolveMarkdownFragment('# intro\necho hi\n', 'intro', false)).toBeNull();
    expect(resolveMarkdownFragment('# intro\necho hi\n', 'L2', false)).toEqual({ line: 2 });
  });
});

describe('源码模式 Cmd/Ctrl+click:链接地址提取', () => {
  // 源码模式的 Markdown 语法同 CodeEditor(lang-markdown 默认 CommonMark:裸 URL 不是链接)
  const doc = '[A](#section-a) plain ![i](./img.png) <https://x.dev> [ref][r]\n\n[r]: ./ref.md\n';
  const state = EditorState.create({ doc, extensions: markdown() });
  ensureSyntaxTree(state, doc.length, 5000);
  const at = (needle: string) => markdownLinkHrefAt(state, doc.indexOf(needle) + 1);
  it.each([
    ['[A]', '#section-a'],
    ['#section-a', '#section-a'],
    ['![i]', './img.png'],
    ['<https', 'https://x.dev'],
  ])('点在 %j 上 → %j', (needle, href) => {
    expect(at(needle)).toBe(href);
  });
  it('不在链接上 / 引用式链接(无地址)→ null', () => {
    expect(at('plain')).toBeNull();
    expect(at('[ref]')).toBeNull();
  });
});
