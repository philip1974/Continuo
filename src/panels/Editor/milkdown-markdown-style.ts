// Milkdown 编辑模式的 Markdown 序列化风格(BDD: src/__tests__/editor-milkdown-roundtrip-style/)。
//
// 上游 remark-stringify 默认风格(`*` 列表、`***` 分隔线、setext 转 ATX、缩进代码转围栏、表格补空格对齐、`<br />` 空行占位)
// 与常见写法(Prettier markdown)不同:在编辑模式里改一处,保存时整篇被改写。这里:
//  - 风格跟随原文件:挂载时解析初始内容(Milkdown 自己的 remark 解析,随首次解析一起跑,不另解析)取第一个无序列表符号、
//    有序列表分隔符、分隔线写法、一二级标题是 setext 还是 ATX、代码块是围栏还是缩进;表格是否对齐按首个表格的表头行与分隔行
//    是否等宽。原文件没有的结构按 Prettier 默认(`-`、`---`、ATX、``` 围栏)。强调 / 加粗的符号由 Milkdown 按节点保留。
//  - 不写 `<br />` 空行占位:去掉 commonmark 预设的 remarkPreserveEmptyLine(连按两次回车留下的空段落序列化时丢弃);
//    手写的 `<br />` 作为 HTML 原样保留。
//  - 少转义:`2 * 3`(两侧空白的 `*`)与 `snake_case`(词内 `_`)不会被解析成强调,不加反斜杠。
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
};

interface MdNode {
  readonly type: string;
  readonly ordered?: boolean | null;
  readonly depth?: number;
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
  readonly children?: readonly MdNode[];
}

/** 按 mdast(带位置)与源码推断风格:各取文档顺序里第一个对应结构。 */
export function inferMarkdownStyle(tree: MdNode, source: string): MarkdownStyle {
  const style: MarkdownStyle = { ...DEFAULT_MARKDOWN_STYLE };
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
      } else if (node.type === 'code' && !seen.has('code')) {
        const ch = source.charAt(start);
        style.fences = ch === '`' || ch === '~';
        if (ch === '`' || ch === '~') style.fence = ch;
        seen.add('code');
      }
    }
    if (node.children) for (const child of node.children) walk(child);
  };
  walk(tree);
  return style;
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

/** 去掉 mdast-util-to-markdown 在纯文字里加的、不会改变解析结果的转义。 */
export function dropNeedlessEscapes(markdown: string): string {
  if (!markdown.includes('\\')) return markdown;
  return markdown.replace(NEEDLESS_STAR_ESCAPE, '$1*').replace(NEEDLESS_UNDERSCORE_ESCAPE, '_');
}

interface MdParent {
  type: string;
  children?: MdParent[];
}

/** 去掉空段落(连按两次回车留下的空行;其余容器里的空段落同理)。原树不动,返回新树。 */
function withoutEmptyParagraphs(node: MdParent): MdParent {
  if (!node.children) return node;
  const children = node.children
    .filter((c) => !(c.type === 'paragraph' && (c.children?.length ?? 0) === 0))
    .map(withoutEmptyParagraphs);
  return { ...node, children };
}

type TextHandler = (node: unknown, parent: unknown, state: unknown, info: unknown) => string;

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
  if (compile) self.compiler = (tree, file) => compile(withoutEmptyParagraphs(tree), file);
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
      return text
        ? { ...prev, handlers: { ...prev.handlers, text: (...args: Parameters<TextHandler>) => dropNeedlessEscapes(text(...args)) } }
        : prev;
    });
    ctx.update(remarkGFMPlugin.options.key, (prev) => ({ ...prev, tablePipeAlign: inferTablePipeAlign(source) }));
  });
}
