// Milkdown 编辑模式的 Markdown 序列化风格(BDD: src/__tests__/editor-milkdown-roundtrip-style/)。
//
// 上游 remark-stringify 默认风格(`*` 列表、`***` 分隔线、setext 转 ATX、缩进代码转围栏、表格补空格对齐、`<br />` 空行占位)
// 与常见写法(Prettier markdown)不同:在编辑模式里改一处,保存时整篇被改写。这里:
//  - 未改动的块原样写回(见 milkdown-source-blocks);这里定的是被改动 / 新建的块的写法。
//  - 风格跟随原文件:挂载时解析初始内容(Milkdown 自己的 remark 解析,随首次解析一起跑,不另解析)取第一个无序列表符号、
//    有序列表分隔符与是否递增编号(`1. 1. 1.`)、分隔线写法、一二级标题是 setext 还是 ATX、代码块是围栏还是缩进、硬换行是
//    `\` 还是行尾两空格、与地址同文的链接是 `<url>` 还是裸写;表格是否对齐按首个表格的表头行与分隔行是否等宽。原文件没有的
//    结构按 Prettier 默认(`-`、`---`、ATX、``` 围栏)。强调 / 加粗的符号由 Milkdown 按节点保留。被改动的块若有原文对应块,
//    再按该块自己的写法覆盖(milkdown-source-blocks)。
//  - 不写 `<br />` 空行占位:去掉 commonmark 预设的 remarkPreserveEmptyLine(连按两次回车留下的空段落序列化时丢弃);
//    手写的 `<br />` 作为 HTML 原样保留。
//  - 少转义:`2 * 3`(两侧空白的 `*`)与 `snake_case`(词内 `_`)不会被解析成强调,文中 `[x]`(后面不是 `(` / `[` / `:`)
//    不会成为链接,都不加反斜杠。
// 引用式链接定义无法保留(Milkdown 解析时把 `[text][ref]` 内联、删掉 `[ref]: …`;schema 没有对应节点),
// 这类文档由 isMilkdownUnsafe 锁在源码模式(见 milkdown-roundtrip-safety)。

import type { Crepe } from '@milkdown/crepe';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark';
import { remarkGFMPlugin } from '@milkdown/kit/preset/gfm';
import { $remark } from '@milkdown/kit/utils';

/** remark-stringify(mdast-util-to-markdown)的风格选项里本模块会设的部分。 */
export interface MarkdownStyle {
  bullet: '-' | '*' | '+';
  bulletOrdered: '.' | ')';
  rule: '-' | '*' | '_';
  ruleRepetition: number;
  ruleSpaces: boolean;
  setext: boolean;
  fences: boolean;
  fence: '`' | '~';
  /** 有序列表编号递增(`1. 2. 3.`);false = 都写首项编号(`1. 1. 1.`)。 */
  incrementListMarker: boolean;
  /** 硬换行写法(Continuo 自有设置,break 处理器读):`\` + 换行 / 行尾两空格。 */
  continuoHardBreak: 'backslash' | 'spaces';
  /** 链接文字与地址相同的链接(Continuo 自有设置):`<https://a.b>` / 裸写 `https://a.b`(GFM 自动链接文字)。 */
  continuoAutolink: 'angle' | 'literal';
}

/** 原文件没有对应结构时的风格(Prettier markdown 默认)。 */
export const DEFAULT_MARKDOWN_STYLE: Readonly<MarkdownStyle> = {
  bullet: '-',
  bulletOrdered: '.',
  rule: '-',
  ruleRepetition: 3,
  ruleSpaces: false,
  setext: false,
  fences: true,
  fence: '`',
  incrementListMarker: true,
  continuoHardBreak: 'backslash',
  continuoAutolink: 'angle',
};

interface MdNode {
  readonly type: string;
  readonly ordered?: boolean | null;
  readonly depth?: number;
  readonly url?: string;
  readonly title?: string | null;
  readonly value?: string;
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
  readonly children?: readonly MdNode[];
  readonly data?: { readonly continuoMath?: unknown; readonly isInline?: unknown };
}

/** 链接文字与地址相同(`<url>` / 裸写的 GFM 自动链接文字,含 `www.` 与邮箱)。 */
function isAutolinkShaped(node: MdNode): boolean {
  const kids = node.children;
  if (node.title || kids?.length !== 1 || kids[0]!.type !== 'text') return false;
  const text = kids[0]!.value ?? '';
  return node.url === text || node.url === `mailto:${text}` || (text.startsWith('www.') && node.url === `http://${text}`);
}

/**
 * 按 mdast(带位置)与源码推断风格:各取文档顺序里第一个对应结构。只含遇到过的结构对应的项
 *(供被改动的块按其原文覆盖全文风格,见 milkdown-source-blocks)。
 */
export function inferMarkdownStyleParts(tree: MdNode, source: string): Partial<MarkdownStyle> {
  const style: Partial<MarkdownStyle> = {};
  const seen = new Set<string>();
  const walk = (node: MdNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === 'list' && !node.ordered && !seen.has('bullet')) {
        const ch = source.charAt(start);
        if (ch === '-' || ch === '*' || ch === '+') style.bullet = ch;
        seen.add('bullet');
      } else if (node.type === 'list' && node.ordered && !seen.has('ordered')) {
        const m = /^\d{1,9}([.)])/.exec(source.slice(start, start + 11));
        if (m) style.bulletOrdered = m[1] as '.' | ')';
        seen.add('ordered');
        // 编号:前两项编号相同 → 不递增(`1. 1. 1.`)
        const second = node.children?.[1]?.position?.start.offset;
        if (second !== undefined) {
          const a = /^\d{1,9}/.exec(source.slice(start, start + 9))?.[0];
          const b = /^\d{1,9}/.exec(source.slice(second, second + 9))?.[0];
          if (a !== undefined && b !== undefined) style.incrementListMarker = Number(a) !== Number(b);
        }
      } else if (node.type === 'thematicBreak' && !seen.has('rule')) {
        const text = source.slice(start, end).trim();
        const ch = text.charAt(0);
        if (ch === '-' || ch === '*' || ch === '_') {
          style.rule = ch;
          style.ruleRepetition = Math.max(3, text.split(ch).length - 1);
          style.ruleSpaces = /[ \t]/.test(text);
        }
        seen.add('rule');
      } else if (node.type === 'heading' && (node.depth ?? 3) <= 2 && !seen.has('heading')) {
        style.setext = source.charAt(start) !== '#';
        seen.add('heading');
      } else if (node.type === 'code' && !seen.has('code') && node.data?.continuoMath === undefined) {
        // `$$` 公式块解析成 language=LaTeX 的 code 节点(见 milkdown-math),不是代码块风格的依据
        const ch = source.charAt(start);
        style.fences = ch === '`' || ch === '~';
        if (ch === '`' || ch === '~') style.fence = ch;
        seen.add('code');
      } else if (node.type === 'break' && node.data?.isInline !== true && !seen.has('break')) {
        style.continuoHardBreak = source.charAt(start) === '\\' ? 'backslash' : 'spaces';
        seen.add('break');
      } else if (node.type === 'link' && !seen.has('autolink') && isAutolinkShaped(node)) {
        const ch = source.charAt(start);
        // `[url](url)` 是普通链接写法,不作依据
        if (ch !== '[') {
          style.continuoAutolink = ch === '<' ? 'angle' : 'literal';
          seen.add('autolink');
        }
      }
    }
    if (node.children) for (const child of node.children) walk(child);
  };
  walk(tree);
  return style;
}

/** 按 mdast(带位置)与源码推断全文风格(原文件没有的结构取默认)。 */
export function inferMarkdownStyle(tree: MdNode, source: string): MarkdownStyle {
  return { ...DEFAULT_MARKDOWN_STYLE, ...inferMarkdownStyleParts(tree, source) };
}

/**
 * 表格是否按列对齐(补空格):看源码里第一个 GFM 表格的各行是否等宽(Prettier 对齐的表格各行等宽,手写的通常不等)。
 * 没有表格 → 对齐(Prettier 默认)。挂载前按初始内容判定(gfm 的表格序列化选项在解析器建立时定死)。
 */
export function inferTablePipeAlign(source: string): boolean {
  if (!source.includes('|')) return true;
  const lines = source.split(/\r\n|\n|\r/);
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.includes('-') || !line.includes('|')) continue;
    if (!/^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)?$/.test(line)) continue;
    const header = lines[i - 1]!;
    if (!header.includes('|')) continue;
    const width = header.trimEnd().length;
    for (let j = i; j < lines.length && lines[j]!.includes('|'); j += 1) {
      if (lines[j]!.trimEnd().length !== width) return false;
    }
    return true;
  }
  return true;
}

// 两侧都是空白的 `*`(不在本段文字开头:行首 `* ` 是列表)不会成为强调分隔符;两侧都是字母 / 数字的 `_` 也不会。
const NEEDLESS_STAR_ESCAPE = /(\S[ \t]+)\\\*(?=[ \t])/g;
const NEEDLESS_UNDERSCORE_ESCAPE = /(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu;
// 文中 `\[x]`:不在文字开头(段首 `[x]` 可能是任务框)、前面不是 `\` / `[` / `!`、括号里没有 `[` `]` `\` 换行且不以 `^`
// 开头(脚注引用)、后面不是 `(` / `[` / `:`(链接 / 引用 / 定义)—— 去掉转义仍是文字(引用式定义的文档锁在源码模式)。
const NEEDLESS_BRACKET_ESCAPE = /(?<=[^\\[!])\\\[(?!\^)([^[\]\\\n]*)\](?![([:])/g;

/**
 * 去掉 mdast-util-to-markdown 在纯文字里加的、不会改变解析结果的转义。`after` = 这段文字之后紧挨的输出字符
 *(文字以 `]` 结尾时据此判断后面是不是 `(` / `[` / `:`)。
 */
export function dropNeedlessEscapes(markdown: string, after = ''): string {
  if (!markdown.includes('\\')) return markdown;
  const out = markdown.replace(NEEDLESS_STAR_ESCAPE, '$1*').replace(NEEDLESS_UNDERSCORE_ESCAPE, '_');
  if (!out.includes('\\[')) return out;
  return out.replace(NEEDLESS_BRACKET_ESCAPE, (m, inner: string, offset: number, all: string) =>
    offset + m.length === all.length && /^[([:]/.test(after) ? m : `[${inner}]`,
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// 硬换行 / 裸链接

interface MdParent {
  type: string;
  children?: MdParent[];
}

interface Unsafe {
  readonly character: string;
  readonly inConstruct?: string | readonly string[];
  readonly notInConstruct?: string | readonly string[];
}
interface StringifyState {
  readonly unsafe: readonly Unsafe[];
  readonly stack: readonly string[];
  readonly options: Record<string, unknown>;
}

function listInScope(stack: readonly string[], list: string | readonly string[] | undefined, none: boolean): boolean {
  const items = typeof list === 'string' ? [list] : list;
  if (!items || items.length === 0) return none;
  return items.some((c) => stack.includes(c));
}

/**
 * mdast-util-to-markdown 的 hardBreak 处理器(不能换行的结构 —— setext 标题、表格 —— 里写空格),换行写法按 continuoHardBreak。
 */
function hardBreak(_node: unknown, _parent: unknown, state: StringifyState, info: { readonly before: string }): string {
  for (const pattern of state.unsafe) {
    if (
      pattern.character === '\n' &&
      listInScope(state.stack, pattern.inConstruct, true) &&
      !listInScope(state.stack, pattern.notInConstruct, false)
    ) {
      return /[ \t]/.test(info.before) ? '' : ' ';
    }
  }
  return state.options.continuoHardBreak === 'spaces' ? '  \n' : '\\\n';
}

// 裸写后按 GFM 自动链接文字解析回同一链接的地址(保守:不含 `&` `*` `_`(域名)`'` 括号等,末字符不是会被剔除的标点)
const BARE_URL =
  /^(?:https?:\/\/|www\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?(?:[/?#][A-Za-z0-9\-._%/?#=+:@,;!$]*)?$/;
const BARE_EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

interface MdLink extends MdParent {
  url?: string;
  title?: string | null;
  value?: string;
}

/**
 * 链接能否裸写:与地址同文、地址形状保守,且前面是段首 / 空白 / 换行、后面是段尾 / 换行 / 空白(之间可有句末标点)。
 * 返回裸写的文字与它是否紧跟在换行之后(`afterEol`)。
 */
function bareLinkText(
  link: MdLink,
  prev: MdLink | undefined,
  next: MdLink | undefined,
  nextNext: MdLink | undefined,
): { readonly text: string; readonly afterEol: boolean } | null {
  if (!isAutolinkShaped(link as MdNode)) return null;
  const text = (link.children![0] as MdLink).value ?? '';
  const ok = BARE_EMAIL.test(text) ? link.url === `mailto:${text}` : BARE_URL.test(text) && /[A-Za-z0-9/=#-]$/.test(text);
  if (!ok) return null;
  const isBreak = (n: MdLink | undefined): boolean => n === undefined || n.type === 'break';
  const prevText = prev?.type === 'text' ? (prev.value ?? '') : null;
  const afterEol = prev?.type === 'break' || (prevText !== null && /\n$/.test(prevText));
  if (prev !== undefined && !afterEol && !(prevText !== null && /[ \t]$/.test(prevText))) return null;
  if (isBreak(next)) return { text, afterEol };
  if (next!.type !== 'text') return null;
  const v = next!.value ?? '';
  if (/^[.,:!?]*\s/.test(v)) return { text, afterEol };
  return /^[.,:!?]*$/.test(v) && isBreak(nextNext) ? { text, afterEol } : null;
}

/**
 * 原文件的自动链接是裸写的:能裸写的链接换成原样输出的 html 节点(mdast 树本次序列化专用,可就地改)。
 * 紧跟换行(软换行 / 硬换行)时把换行并进 html 节点 —— mdast-util-to-markdown 会把「换行 + 行内 html」的换行改成空格
 *(防止被当成 html 块),只在段落里这样做(标题 / 表格单元格里不能换行)。
 */
function writeBareLinks(node: MdParent, hardBreak: string): void {
  const kids = node.children;
  if (!kids) return;
  for (let i = 0; i < kids.length; i += 1) {
    const child = kids[i]!;
    const bare = child.type === 'link' ? bareLinkText(child, kids[i - 1], kids[i + 1], kids[i + 2]) : null;
    if (bare === null) {
      writeBareLinks(child, hardBreak);
      continue;
    }
    if (!bare.afterEol) {
      kids[i] = { type: 'html', value: bare.text } as MdLink;
      continue;
    }
    if (node.type !== 'paragraph') continue;
    const prev = kids[i - 1] as MdLink;
    let eol: string;
    if (prev.type === 'break') {
      eol = hardBreak;
      kids.splice(i - 1, 1);
      i -= 1;
    } else {
      eol = '\n';
      prev.value = prev.value!.slice(0, -1);
      if (prev.value === '') {
        kids.splice(i - 1, 1);
        i -= 1;
      }
    }
    kids[i] = { type: 'html', value: eol + bare.text } as MdLink;
  }
}

/** 去掉空段落(连按两次回车留下的空行;其余容器里的空段落同理)。原树不动,返回新树。 */
function withoutEmptyParagraphs(node: MdParent): MdParent {
  if (!node.children) return node;
  const children = node.children
    .filter((c) => !(c.type === 'paragraph' && (c.children?.length ?? 0) === 0))
    .map(withoutEmptyParagraphs);
  return { ...node, children };
}

type TextHandler = (node: unknown, parent: unknown, state: unknown, info: { readonly after?: string }) => string;

/** remark 插件:首次解析(挂载时的初始内容)时按原文推断风格写进 stringify 设置;序列化前丢弃空段落。 */
/** 本插件用到的 unified 处理器部分(unified 非直接依赖)。 */
interface ProcessorLike {
  data(key: 'settings'): Record<string, unknown> | undefined;
  data(key: 'settings', value: Record<string, unknown>): void;
  compiler?: (tree: MdParent, file: unknown) => string;
}

const markdownStylePlugin = $remark('continuoMarkdownStyle', () => function continuoMarkdownStyle(this: unknown) {
  const self = this as ProcessorLike;
  // remark-stringify 每次序列化时读 data('settings')(低于 remarkStringifyOptions 里的项,故风格只放这里)
  let settings = self.data('settings');
  if (!settings) {
    settings = {};
    self.data('settings', settings);
  }
  Object.assign(settings, DEFAULT_MARKDOWN_STYLE);
  const compile = self.compiler;
  if (compile) {
    self.compiler = (tree, file) => {
      const clean = withoutEmptyParagraphs(tree);
      if (settings!.continuoAutolink === 'literal') {
        writeBareLinks(clean, settings!.continuoHardBreak === 'spaces' ? '  \n' : '\\\n');
      }
      return compile(clean, file);
    };
  }
  let inferred = false;
  return (tree: MdNode, file: { value?: unknown }) => {
    if (inferred) return; // 之后的解析(粘贴片段、外部内容同步)不改风格
    inferred = true;
    if (typeof file.value === 'string') Object.assign(settings!, inferMarkdownStyle(tree, file.value));
  };
});

/** 在 crepe.create() 之前调用:按初始内容 `source` 配置序列化风格。 */
export function configureMarkdownStyle(crepe: Crepe, source: string): void {
  const editor = crepe.editor;
  void editor.remove(remarkPreserveEmptyLinePlugin);
  editor.use(markdownStylePlugin);
  editor.config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (prev) => {
      const text = (prev.handlers as Record<string, TextHandler> | undefined)?.text;
      const handlers: Record<string, unknown> = { ...prev.handlers, break: hardBreak };
      if (text) {
        handlers.text = (...args: Parameters<TextHandler>) => dropNeedlessEscapes(text(...args), args[3]?.after ?? '');
      }
      return { ...prev, handlers: handlers as typeof prev.handlers };
    });
    ctx.update(remarkGFMPlugin.options.key, (prev) => ({ ...prev, tablePipeAlign: inferTablePipeAlign(source) }));
  });
}
