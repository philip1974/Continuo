// `#片段` → 源码里的目标位置(VSCode markdown 语言服务:先找标题,再认行号片段)。BDD: src/__tests__/markdown-anchor-links/
// - 标题:按源码模式同一个 Markdown 解析器(@codemirror/lang-markdown 的 lezer,CommonMark + GFM)收集全文标题(ATX / setext,
//   含引用 / 列表项里的;代码块里的 `#` 不是标题;文首 YAML frontmatter 先抹成空白、保留行号),取渲染后的文字(去掉强调 /
//   删除线 / 链接地址 / 图片 / 行内 HTML 等标记,行内代码留内容)按文档顺序算 slug(markdown-heading-slug,与渲染出的标题 id
//   同一规则)。片段按 URL 解码后与 slug 不区分大小写比较(VSCode fromFragment / GithubSlug.equals)。
// - 行号:`#L10`、`#L10,5`、`#10`、`#L10-L20`(取起点;VSCode getSelectionFromLocationFragment)。
// 本模块静态引入 lezer 解析器:调用方(markdown-link-follow)动态加载。

import { markdownLanguage } from '@codemirror/lang-markdown';
import { createSlugBuilder } from './markdown-heading-slug';

export interface MarkdownHeading {
  /** 标题起始的源码行(1 起;setext 标题取文字的第一行)。 */
  readonly line: number;
  /** 渲染后的文字。 */
  readonly text: string;
  readonly slug: string;
}

/** 不出现在渲染文字里的语法节点(整段跳过)。 */
const SKIP = new Set([
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'LinkMark',
  'LinkTitle',
  'LinkLabel',
  'Image', // 图片渲染成原子节点,不含文字
  'HTMLTag', // 行内 HTML 同上
]);

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntity(raw: string): string {
  const body = raw.slice(1, -1);
  if (body.startsWith('#')) {
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
  }
  return ENTITIES[body] ?? raw;
}

/** 文首 YAML frontmatter(`---` … `---` / `...`)抹成空白(换行保留,行号不变)。 */
function blankFrontmatter(source: string): string {
  const first = /^---[ \t]*\r?\n/.exec(source);
  if (!first) return source;
  const close = /^(?:---|\.\.\.)[ \t]*$/m;
  const rest = source.slice(first[0].length);
  const m = close.exec(rest);
  if (!m) return source;
  const end = first[0].length + m.index + m[0].length;
  return source.slice(0, end).replace(/[^\r\n]/g, ' ') + source.slice(end);
}

/** 源码里的标题,按文档顺序,带 slug(重复加 -1 / -2;空标题不收)。 */
export function markdownHeadings(source: string): MarkdownHeading[] {
  const text = blankFrontmatter(source);
  const tree = markdownLanguage.parser.parse(text);
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const lineAt = (pos: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const slugOf = createSlugBuilder();
  const out: MarkdownHeading[] = [];
  tree.iterate({
    enter: (node) => {
      if (!/^(?:ATX|Setext)Heading[1-6]$/.test(node.name)) return true;
      // 标题范围内的文字:跳过标记节点;转义只留被转义的字符;实体解码;URL 只在自动链接里算文字
      let raw = '';
      let pos = node.from;
      const take = (to: number): void => {
        if (to > pos) raw += text.slice(pos, to);
        pos = Math.max(pos, to);
      };
      node.node.cursor().iterate((child) => {
        if (child.from === node.from && child.to === node.to) return true; // 标题本身
        const name = child.name;
        const parent = child.node.parent?.name;
        if (SKIP.has(name) || (name === 'URL' && parent !== 'Autolink')) {
          take(child.from);
          pos = Math.max(pos, child.to);
          return false;
        }
        if (name === 'Escape') {
          take(child.from);
          raw += text.slice(child.from + 1, child.to);
          pos = child.to;
          return false;
        }
        if (name === 'Entity') {
          take(child.from);
          raw += decodeEntity(text.slice(child.from, child.to));
          pos = child.to;
          return false;
        }
        return true;
      });
      take(node.to);
      // setext 多行:续行行首缩进不算文字
      const plain = raw.replace(/[ \t]*\r?\n[ \t]*/g, '\n').trim();
      if (plain !== '') out.push({ line: lineAt(node.from), text: plain, slug: slugOf(plain) });
      return false;
    },
  });
  return out;
}

const LINE_FRAGMENT = /^L?(\d+)(?:,(\d+))?(?:-L?(\d+)(?:,(\d+))?)?$/i;

/**
 * `#片段` → 源码里的目标位置:先按标题 slug(headings = false 时不找标题:非 Markdown 文件),再按行号片段;都不是 → null。
 */
export function resolveMarkdownFragment(
  source: string,
  fragment: string,
  headings = true,
): { line: number; column?: number } | null {
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    /* 非法 percent 序列:按原样比较 */
  }
  if (decoded === '') return null;
  const wanted = decoded.toLowerCase();
  const heading = headings ? markdownHeadings(source).find((h) => h.slug !== '' && h.slug === wanted) : undefined;
  if (heading) return { line: heading.line };
  const m = LINE_FRAGMENT.exec(decoded);
  if (!m) return null;
  const line = Number(m[1]);
  if (!Number.isSafeInteger(line) || line < 1) return null;
  const column = m[2] === undefined ? undefined : Number(m[2]);
  return column !== undefined && Number.isSafeInteger(column) && column >= 1 ? { line, column } : { line };
}
