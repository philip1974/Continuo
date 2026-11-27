// Milkdown 编辑模式:未改动的块原样写回,行尾跟随原文件(BDD: src/__tests__/editor-milkdown-roundtrip-verbatim/)。
//
// Milkdown 每次保存都把整篇 ProseMirror 文档经 remark-stringify 重写:改一处,别处的常见写法(`|---|`、无首尾竖线的表格、
// `1. 1. 1.`、裸链接、行尾两空格硬换行、文末空行……)被改成 remark 的写法。这里包一层序列化器:
//  - 挂载时(随 Milkdown 对初始内容的那次解析,不另解析)记下每个顶层块的 ProseMirror 节点、mdast 节点与源码区间,以及块间原文
//   (空行数、文首文末)。外部内容同步(另一编辑器组 / 状态栏改行尾)后按新内容重建。
//  - 序列化时逐个顶层块找原文块:同一节点(ProseMirror 节点不可变,未改的块在事务间保持同一对象;拖动 / 撤销也还原同一对象),
//   否则内容相同(忽略不写进 Markdown 的属性:标题 id、列表项 label)。找到 → 原文切片;相邻且在原文里也相邻 → 原样块间原文。
//  - 没找到的块(被改动 / 新建)走 remark。夹在两个原文块之间、与原文一一对应(块数、类型相同 = 只改了块内容)时:块间原文照旧,
//   每块按其原文块自己的写法序列化(列表符号、编号、标题、围栏……);列表逐项、表格逐行再找原文(未改的项 / 行原样,改动的
//   项按原列表的符号与编号写、改动的行按原表格的竖线 / 空格 / 对齐写,分隔行列数与对齐未变则原样),拼好后用同一解析器
//   试解析,结构与当前块不同就退回 remark。其余情形(拆分 / 合并 / 插入)整段走 remark,块间写一个空行。
//  - 两个列表(或列表与代码块)变成相邻而原文不相邻时并入 remark 那一段(原样拼接会让它们合并成一个列表)。原文最后一块是
//   没闭合的围栏代码块且后面又有块时也不原样写(它会吞掉后面的内容)。
//  - 嵌套更深的结构(列表项里的子列表、引用里的块)不再逐层原样:所在列表项 / 引用被改动时按风格推断重写(见 milkdown-markdown-style)。
//  - 行尾:原文件所有换行都是 CRLF(与 CodeEditor 同口径,detectLineEnding)→ 输出统一成 CRLF。

import type { Crepe } from '@milkdown/crepe';
import {
  EditorStateReady,
  SerializerReady,
  editorStateCtx,
  editorViewCtx,
  parserCtx,
  remarkCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx';
import type { Node as PmNode } from '@milkdown/kit/prose/model';
import { $remark } from '@milkdown/kit/utils';
import { convertLineEndings, detectLineEnding } from './editor-encoding';
import { inferMarkdownStyleParts, type MarkdownStyle } from './milkdown-markdown-style';

interface MdNode {
  readonly type: string;
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
  readonly children?: readonly MdNode[];
}

/** 一个原文块:挂载(或外部内容同步)时的 ProseMirror 节点、对应 mdast 节点与源码区间。 */
interface SourceBlock {
  readonly node: PmNode;
  readonly md: MdNode;
  readonly from: number;
  readonly to: number;
  /** 子块(列表项 / 表格行),用到时才配对;null = 配不上。 */
  children?: SourceLevel | null;
  /** 该块自己的写法(用到时才推断)。 */
  style?: Partial<MarkdownStyle>;
}

/** 同一容器里的原文块与块间原文:gaps[i] = 第 i 块之前的原文,gaps[n] = 最后一块之后。 */
interface SourceLevel {
  readonly blocks: readonly SourceBlock[];
  readonly gaps: readonly string[];
  identity?: Map<PmNode, number>;
  byKey?: Map<string, number[]>;
  memo?: WeakMap<PmNode, readonly number[]>;
}

interface Bound {
  readonly source: string;
  readonly level: SourceLevel;
}

/** Milkdown 不为其建 ProseMirror 节点的 mdast 块(链接引用定义)。 */
const UNMAPPED_MD = new Set(['definition']);

/** mdast 类型 → 可能对应的 ProseMirror 节点类型(表里没有的不检查)。 */
const COMPATIBLE: Readonly<Record<string, readonly string[]>> = {
  paragraph: ['paragraph'],
  heading: ['heading'],
  thematicBreak: ['hr'],
  blockquote: ['blockquote'],
  list: ['bullet_list', 'ordered_list'],
  listItem: ['list_item'],
  code: ['code_block'],
  html: ['html', 'paragraph'],
  table: ['table'],
  tableRow: ['table_header_row', 'table_row'],
};

/** 空段落:序列化时丢弃(见 milkdown-markdown-style),不算块。 */
function isEmptyParagraph(node: PmNode): boolean {
  return node.type.name === 'paragraph' && node.childCount === 0;
}

function blockChildren(node: PmNode): PmNode[] {
  const out: PmNode[] = [];
  node.forEach((child) => {
    if (!isEmptyParagraph(child)) out.push(child);
  });
  return out;
}

/** 容器的子块与 mdast 子节点按序配对(数目、类型对不上或缺位置 → null)。 */
function pairLevel(pm: PmNode, md: MdNode, source: string, from: number, to: number): SourceLevel | null {
  const pmKids = blockChildren(pm);
  const mdKids = (md.children ?? []).filter((c) => !UNMAPPED_MD.has(c.type));
  if (pmKids.length !== mdKids.length) return null;
  const blocks: SourceBlock[] = [];
  const gaps: string[] = [];
  let cursor = from;
  for (let i = 0; i < mdKids.length; i += 1) {
    const m = mdKids[i]!;
    const start = m.position?.start.offset;
    const end = m.position?.end.offset;
    if (start === undefined || end === undefined || start < cursor || end < start || end > to) return null;
    const ok = COMPATIBLE[m.type];
    if (ok && !ok.includes(pmKids[i]!.type.name)) return null;
    gaps.push(source.slice(cursor, start));
    blocks.push({ node: pmKids[i]!, md: m, from: start, to: end });
    cursor = end;
  }
  gaps.push(source.slice(cursor, to));
  return { blocks, gaps };
}

// 不写进 Markdown 的属性(挂载后 / 编辑后由插件改写:标题 id、有序列表项 label)
const IGNORED_ATTRS: Readonly<Record<string, readonly string[]>> = {
  heading: ['id'],
  list_item: ['label', 'listType'],
};

function attrEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 两个块写成 Markdown 是否相同:同一节点,或类型 / 属性(忽略上表)/ 标记 / 文字 / 子节点都相同。 */
export function sameBlock(a: PmNode, b: PmNode): boolean {
  if (a === b) return true;
  if (a.type !== b.type || a.childCount !== b.childCount || a.isText !== b.isText) return false;
  if (a.isText && a.text !== b.text) return false;
  if (a.marks.length !== b.marks.length || a.marks.some((m, i) => !m.eq(b.marks[i]!))) return false;
  const ignored = IGNORED_ATTRS[a.type.name];
  for (const key of Object.keys(a.attrs)) {
    if (!ignored?.includes(key) && !attrEqual(a.attrs[key], b.attrs[key])) return false;
  }
  for (let i = 0; i < a.childCount; i += 1) if (!sameBlock(a.child(i), b.child(i))) return false;
  return true;
}

/** 与节点写法相同的原文块下标(同一节点直接命中;否则按类型 + 文字筛候选再逐个比较,结果按节点记住)。 */
function candidatesIn(level: SourceLevel, node: PmNode): readonly number[] {
  level.identity ??= new Map(level.blocks.map((b, i) => [b.node, i]));
  const id = level.identity.get(node);
  if (id !== undefined) return [id];
  level.memo ??= new WeakMap();
  const memo = level.memo.get(node);
  if (memo) return memo;
  if (!level.byKey) {
    const byKey = new Map<string, number[]>();
    level.blocks.forEach((b, i) => {
      const key = `${b.node.type.name}\u0000${b.node.textContent}`;
      const list = byKey.get(key);
      if (list) list.push(i);
      else byKey.set(key, [i]);
    });
    level.byKey = byKey;
  }
  const found = (level.byKey.get(`${node.type.name}\u0000${node.textContent}`) ?? []).filter((i) =>
    sameBlock(node, level.blocks[i]!.node),
  );
  level.memo.set(node, found);
  return found;
}

/** 逐个子块找原文块(-1 = 没有);有多个候选时优先接着上一个原文块的那个。 */
function matchLevel(level: SourceLevel, nodes: readonly PmNode[]): number[] {
  const out: number[] = [];
  let prev = -1;
  for (const node of nodes) {
    const c = candidatesIn(level, node);
    const i = c.length === 0 ? -1 : c.includes(prev + 1) ? prev + 1 : c[0]!;
    out.push(i);
    if (i >= 0) prev = i;
  }
  return out;
}

function isList(node: PmNode): boolean {
  return node.type.name === 'bullet_list' || node.type.name === 'ordered_list';
}

/** 没闭合的围栏代码块 / `$$` 公式块(延伸到文末):后面再接块时不能原样写。 */
function isOpenEnded(source: string, block: SourceBlock): boolean {
  if (block.md.type !== 'code') return false;
  const text = source.slice(block.from, block.to);
  const fence = /^(`{3,}|~{3,}|\${2,})/.exec(text)?.[1];
  if (!fence) return false;
  const nl = text.lastIndexOf('\n');
  if (nl < 0) return true;
  const last = text.slice(nl + 1).trim();
  return !(last.length >= fence.length && last === fence[0]!.repeat(last.length));
}

interface Serializers {
  /** 若干块按全文风格走 remark(无末尾换行)。 */
  run(nodes: readonly PmNode[]): string;
  /** 一个被改动的块,按其原文块的写法(无末尾换行)。 */
  one(node: PmNode, counterpart: SourceBlock): string;
}

/** 顶层:原文块原样、块间原文照旧,其余走 remark(见文件头注释)。 */
function assemble(bound: Bound, kids: readonly PmNode[], ser: Serializers): string {
  const { source, level } = bound;
  const { blocks, gaps } = level;
  const n = blocks.length;
  if (kids.length === 0) return n === 0 ? source : '';
  const orig = matchLevel(level, kids);
  for (let k = 0; k < kids.length - 1; k += 1) {
    if (orig[k] === n - 1 && isOpenEnded(source, blocks[n - 1]!)) orig[k] = -1;
  }
  // 原文不相邻的两个列表 / 列表与代码块:并入 remark 那一段(由它决定换用列表符号等)
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = 1; k < kids.length; k += 1) {
      const a = orig[k - 1]!;
      const b = orig[k]!;
      if ((a >= 0 && b === a + 1) || (a < 0 && b < 0)) continue;
      if (isList(kids[k - 1]!) && (isList(kids[k]!) || kids[k]!.type.name === 'code_block')) {
        orig[k - 1] = -1;
        orig[k] = -1;
        changed = true;
      }
    }
  }
  let out = '';
  let a = -1; // 上一个原样写出的原文块
  for (let k = 0; k <= kids.length; ) {
    let r = k;
    while (r < kids.length && orig[r]! < 0) r += 1;
    const b = r < kids.length ? orig[r]! : n;
    const run = kids.slice(k, r);
    if (run.length === 0) {
      out += b === a + 1 ? gaps[b]! : a < 0 ? '' : b === n ? gaps[n]! : '\n\n';
    } else if (b - a - 1 === run.length && run.every((node, j) => node.type === blocks[a + 1 + j]!.node.type)) {
      // 与原文一一对应(只改了块内容):块间原文照旧,每块按原文块的写法
      run.forEach((node, j) => {
        out += gaps[a + 1 + j]!;
        out += ser.one(node, blocks[a + 1 + j]!);
      });
      out += gaps[b]!;
    } else {
      out += a < 0 ? '' : '\n\n';
      out += ser.run(run);
      // 原文没有块(空文件)→ 按 remark 以换行结尾;否则文末沿用原文(含「没有末尾换行」)
      out += b === n ? (n === 0 ? '\n' : gaps[n]!) : '\n\n';
    }
    if (r < kids.length) out += source.slice(blocks[b]!.from, blocks[b]!.to);
    a = b;
    k = r + 1;
  }
  // 原文最后一块是没闭合的围栏(它的区间吞掉了文末换行,gaps[n] 为空)且没有原样写在末尾(被改动 / 后面接了块 / 被删):
  // 原文以换行结尾 → 输出也以换行结尾,否则文末换行丢失
  if (n > 0 && gaps[n] === '' && !out.endsWith('\n') && isOpenEnded(source, blocks[n - 1]!)) {
    if (source.endsWith('\n')) out += source.endsWith('\r\n') ? '\r\n' : '\n';
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 表格:逐行

type Align = '' | 'l' | 'r' | 'c';

/** 表格行按未转义的 `|` 拆成单元格(去掉首尾竖线与两侧空白)。 */
export function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  let backslashes = 0;
  for (let i = s.length - 2; i >= 0 && s[i] === '\\'; i -= 1) backslashes += 1;
  if (s.endsWith('|') && backslashes % 2 === 0) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length) {
      cell += ch + s[i + 1]!;
      i += 1;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(delimiterCell: string): Align {
  const l = delimiterCell.startsWith(':');
  const r = delimiterCell.endsWith(':') && delimiterCell.length > 1;
  return l && r ? 'c' : l ? 'l' : r ? 'r' : '';
}

interface TableStyle {
  readonly outer: boolean;
  readonly padding: boolean;
}

/** 按原表格的竖线 / 空格写一行(首尾单元格为空或只有一列时补首尾竖线,否则解析不成同一行)。 */
function joinTableRow(cells: readonly string[], style: TableStyle): string {
  const body = cells.join(style.padding ? ' | ' : '|');
  const outer = style.outer || cells.length < 2 || cells[0]!.trim() === '' || cells[cells.length - 1]!.trim() === '';
  if (!outer) return body;
  return style.padding ? `| ${body} |` : `|${body}|`;
}

function padCell(cell: string, width: number, align: Align): string {
  const gap = Math.max(0, width - cell.length);
  if (align === 'r') return ' '.repeat(gap) + cell;
  if (align === 'c') return ' '.repeat(Math.floor(gap / 2)) + cell + ' '.repeat(Math.ceil(gap / 2));
  return cell + ' '.repeat(gap);
}

function delimiterCell(align: Align, width: number): string {
  const left = align === 'l' || align === 'c' ? ':' : '';
  const right = align === 'r' || align === 'c' ? ':' : '';
  return left + '-'.repeat(Math.max(1, width - left.length - right.length)) + right;
}

function trimmedWidth(line: string): number {
  return line.trim().length;
}

/**
 * 被改动的表格:未改的行原样;改动的行按原表格的写法(竖线 / 空格;原表格按列对齐则重新对齐,列宽未变时未改的行仍原样);
 * 分隔行列数与对齐未变(对齐的表格还要列宽未变)则原样。拼不出 → null。
 */
function serializeTable(source: string, level: SourceLevel, node: PmNode, remarkOut: string): string | null {
  const rows = blockChildren(node);
  const lines = remarkOut.split('\n');
  if (lines.length !== rows.length + 1 || level.blocks.length < 1) return null;
  const parsed = lines.map(splitTableRow);
  const aligns = parsed[1]!.map(alignOf);
  const cells = [parsed[0]!, ...parsed.slice(2)];
  const slice = (b: SourceBlock): string => source.slice(b.from, b.to);
  const origRows = level.blocks.map(slice);
  const delimLine = level.gaps[1]!.split(/\r?\n/).find((l) => l.trim() !== '')?.trim();
  if (!delimLine) return null;
  const origDelim = splitTableRow(delimLine);
  const header = origRows[0]!.trim();
  const padded = (line: string): boolean => /[ \t]\||\|[ \t]/.test(line);
  const style: TableStyle = { outer: header.startsWith('|'), padding: padded(header) };
  // 按列对齐(Prettier):各行等宽,且分隔行与表头同样带空格(`| a | b |` + `|---|---|` 只是碰巧等宽)
  const aligned =
    padded(delimLine) === style.padding && [...origRows, delimLine].every((l) => trimmedWidth(l) === trimmedWidth(header));
  const sameShape = origDelim.length === aligns.length && origDelim.every((c, i) => alignOf(c) === aligns[i]);
  const orig = matchLevel(level, rows);
  let widths: number[] = [];
  let widthsSame = true;
  if (aligned) {
    const min = origDelim.every((c) => c.length >= 3) ? 3 : 1;
    widths = aligns.map((al, c) =>
      Math.max(min, al === 'c' ? 3 : al ? 2 : 1, ...cells.map((row) => (row[c] ?? '').length)),
    );
    widthsSame = sameShape && origDelim.every((c, i) => c.length === widths[i]);
  }
  const keep = (j: number): boolean => orig[j]! >= 0 && widthsSame;
  const format = (row: readonly string[]): string =>
    joinTableRow(aligned ? aligns.map((al, c) => padCell(row[c] ?? '', widths[c]!, al)) : row, style);
  const out: string[] = [];
  cells.forEach((row, j) => {
    out.push(keep(j) ? origRows[orig[j]!]! : format(row));
    if (j === 0) {
      if (sameShape && widthsSame) out.push(delimLine);
      else {
        const dash = origDelim[0]?.replace(/:/g, '').length || 3;
        out.push(joinTableRow(aligns.map((al, c) => delimiterCell(al, aligned ? widths[c]! : dash + (al === 'c' ? 2 : al ? 1 : 0))), style));
      }
    }
  });
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// 列表:逐项

/** 被改动的列表:未改的项原样,改动的项按原列表的符号 / 编号单独写。拼不出 / 没有能原样的项 → null。 */
function serializeList(
  cp: SourceBlock,
  level: SourceLevel,
  node: PmNode,
  source: string,
  writeItem: (list: PmNode) => string,
): string | null {
  const items = blockChildren(node);
  const orig = matchLevel(level, items);
  if (orig.every((i) => i < 0)) return null;
  const ordered = node.type.name === 'ordered_list';
  const start = Number(node.attrs.order ?? 1);
  const increment = inferMarkdownStyleParts(cp.md, source).incrementListMarker !== false;
  const between = level.blocks.length > 1 ? level.gaps[1]!.replace(/[ \t]+$/, '') : node.attrs.spread ? '\n\n' : '\n';
  let out = '';
  items.forEach((item, j) => {
    if (j > 0) {
      const a = orig[j - 1]!;
      const b = orig[j]!;
      out += a >= 0 && b === a + 1 ? level.gaps[b]! : between;
    }
    const i = orig[j]!;
    if (i >= 0) {
      out += source.slice(level.blocks[i]!.from, level.blocks[i]!.to);
      return;
    }
    const attrs = ordered ? { ...node.attrs, order: increment ? start + j : start } : node.attrs;
    out += writeItem(node.type.create(attrs, [item]));
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 块内文字:就地改原文

interface MdLeaf extends MdNode {
  readonly value?: string;
  readonly data?: { readonly isInline?: unknown };
}

/** 行内叶子(公式、硬换行、图片、行内 HTML……)在扁平文字里的占位。 */
const LEAF = '\uFFFC';
/** 扁平文字里按原文逐字对应的 mdast 节点。 */
const SPLICEABLE = new Set(['text', 'inlineCode']);

/** ProseMirror 块的扁平文字:文字逐字,其余叶子各一个占位。 */
function pmFlat(node: PmNode): string {
  let out = '';
  node.descendants((n) => {
    if (n.isText) out += n.text;
    else if (n.isLeaf) out += LEAF;
    return true;
  });
  return out;
}

interface FlatLeaf {
  readonly md: MdLeaf;
  readonly at: number;
}

/** Milkdown 把文字里的换行拆成 isInline 的 break(软换行),拆出的文字 / break 没有位置。 */
function isSplitPiece(node: MdLeaf): boolean {
  return node.position === undefined && (node.type === 'text' || (node.type === 'break' && node.data?.isInline === true));
}

interface FlatMd {
  readonly text: string;
  readonly leaves: readonly FlatLeaf[];
  /** 节点边界:扁平文字下标 → 原文偏移(节点之间插字的候选处)。 */
  readonly edges: ReadonlyArray<{ readonly at: number; readonly offset: number }>;
}

/** mdast 块的扁平文字(与 pmFlat 同口径)、可就地改的叶子与节点边界。 */
function mdFlat(md: MdLeaf): FlatMd {
  let text = '';
  const leaves: FlatLeaf[] = [];
  const edges: Array<{ at: number; offset: number }> = [];
  const edge = (offset: number | undefined): void => {
    if (offset !== undefined) edges.push({ at: text.length, offset });
  };
  const walk = (parent: MdLeaf): void => {
    const kids = (parent.children ?? []) as readonly MdLeaf[];
    for (let i = 0; i < kids.length; i += 1) {
      const node = kids[i]!;
      edge(node.position?.start.offset);
      if (isSplitPiece(node)) {
        // 被拆开的一段文字合回一个叶子(软换行记作 `\n`,扁平文字里仍是一个占位),区间取前后有位置的兄弟之间
        let j = i;
        let value = '';
        const at = text.length;
        for (; j < kids.length && isSplitPiece(kids[j]!); j += 1) {
          const piece = kids[j]!;
          value += piece.type === 'text' ? (piece.value ?? '') : '\n';
          text += piece.type === 'text' ? (piece.value ?? '') : LEAF;
        }
        const from = i > 0 ? kids[i - 1]!.position?.end.offset : parent.position?.start.offset;
        const to = j < kids.length ? kids[j]!.position?.start.offset : parent.position?.end.offset;
        if (from !== undefined && to !== undefined) {
          leaves.push({ md: { type: 'text', value, position: { start: { offset: from }, end: { offset: to } } }, at });
        }
        i = j - 1;
      } else if (typeof node.value === 'string' && (SPLICEABLE.has(node.type) || node.type === 'code')) {
        if (SPLICEABLE.has(node.type)) leaves.push({ md: node, at: text.length });
        text += node.value;
      } else if (node.children) walk(node);
      else text += LEAF;
      edge(node.position?.end.offset);
    }
  };
  walk(md);
  return { text, leaves, edges };
}

/**
 * 叶子内容第 a..b 个字符在原文里的区间:内容按行切开,逐行在原文里找(行内代码先跳过开头的反引号,`skipPad` 时再跳过补的一个空格 / 换行;行与行之间
 * 只能是行尾空白、换行与容器前缀 `>` / 缩进)。对不上(转义、实体……)→ null。
 */
function leafRange(source: string, leaf: MdLeaf, a: number, b: number, skipPad: boolean): readonly [number, number] | null {
  const start = leaf.position?.start.offset;
  const end = leaf.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  const value = leaf.value ?? '';
  const lines = value.split(/\r\n|\n|\r/);
  let cursor = start;
  if (leaf.type === 'inlineCode') {
    cursor += /^`*/.exec(source.slice(start, end))![0].length;
    // 两端补的一个空格(或换行,续行带容器前缀)
    const pad = / |(?:\r\n|\n|\r)[ \t>]*/y;
    pad.lastIndex = cursor;
    if (skipPad && pad.exec(source)) cursor = pad.lastIndex;
    else if (skipPad) return null;
  }
  let offset = 0; // 当前行在 value 里的起点
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (i > 0) {
      const gap = /[ \t]*(?:\r\n|\n|\r)[ \t>]*/y;
      gap.lastIndex = cursor;
      if (!gap.exec(source)) return null;
      cursor = gap.lastIndex;
    }
    if (!source.startsWith(line, cursor) || cursor + line.length > end) return null;
    if (a >= offset && b <= offset + line.length) return [cursor + a - offset, cursor + b - offset];
    offset += line.length + (/^\r\n/.test(value.slice(offset + line.length)) ? 2 : 1);
    cursor += line.length;
    if (a < offset) return null; // 改动跨行
  }
  return null;
}

/**
 * 只改了块里一处文字(打字 / 删字,标记与结构不变):在原文里就地替换那几个字 —— 块里其余字节不变(remark 重写整块会改掉
 * 跨行行内代码里的换行、两端空格等)。替换后用同一解析器解析回来须与当前块相同,否则 null。
 */
function spliceText(source: string, cp: SourceBlock, node: PmNode, roundTrips: (md: string, node: PmNode) => boolean): string | null {
  const before = pmFlat(cp.node);
  const after = pmFlat(node);
  const flat = mdFlat(cp.md as MdLeaf);
  if (flat.text !== before || before === after) return null;
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p += 1;
  let q = 0;
  while (q < max - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q += 1;
  const e = before.length - q;
  const insert = after.slice(p, after.length - q);
  if (before.slice(p, e).includes(LEAF) || insert.includes(LEAF)) return null;
  // 候选处:含改动处的文字 / 行内代码叶子;纯插入还可以在两个节点之间(如行内代码与公式之间)
  const ranges: Array<readonly [number, number]> = [];
  for (const leaf of flat.leaves) {
    if (p < leaf.at || e > leaf.at + leaf.md.value!.length) continue;
    // 行内代码两端可能补了一个空格(内容本身也可能以空格开头):两种对齐都试
    for (const skipPad of leaf.md.type === 'inlineCode' ? [false, true] : [false]) {
      const range = leafRange(source, leaf.md, p - leaf.at, e - leaf.at, skipPad);
      if (range) ranges.push(range);
    }
  }
  if (p === e) for (const { at, offset } of flat.edges) if (at === p) ranges.push([offset, offset]);
  const block = source.slice(cp.from, cp.to);
  const tried = new Set<string>();
  for (const [from, to] of ranges) {
    const key = `${from}:${to}`;
    if (from < cp.from || to > cp.to || tried.has(key)) continue;
    tried.add(key);
    const out = block.slice(0, from - cp.from) + insert + block.slice(to - cp.from);
    if (roundTrips(out, node)) return out;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------

interface ProcessorLike {
  data(key: 'settings'): Record<string, unknown> | undefined;
  parse(markdown: string): unknown;
  runSync(tree: unknown, file?: string): unknown;
}
type Serializer = (doc: PmNode) => string;

function stripNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

/** 保守写法:地址同文的链接写 `<url>`,文字里的 `$` 与反引号一律转义(continuoSafeEscapes 见 milkdown-math / milkdown-markdown-style)。 */
const SAFE_STYLE: Readonly<Record<string, unknown>> = { continuoAutolink: 'angle', continuoSafeEscapes: true };

/** 整段走 remark 的块解析回来不同时依次试的写法。 */
const RUN_FALLBACKS: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  { continuoInlineCodeEol: 'keep' },
  SAFE_STYLE,
  { ...SAFE_STYLE, continuoInlineCodeEol: 'keep' },
];

function createSerializers(ctx: Ctx, bound: Bound, base: Serializer): Serializers {
  const remark = ctx.get(remarkCtx) as unknown as ProcessorLike;
  const docOf = (nodes: readonly PmNode[]): PmNode => nodes[0]!.type.schema.topNodeType.create(null, nodes);
  const write = (nodes: readonly PmNode[]): string => stripNewline(base(docOf(nodes)));
  // 按块的原文写法临时覆盖 remark-stringify 设置(序列化是同步的,写完即还原)
  const withStyle = <T,>(style: Readonly<Record<string, unknown>>, fn: () => T): T => {
    const settings = remark.data('settings');
    if (!settings) return fn();
    const saved: Record<string, unknown> = {};
    for (const key of Object.keys(style)) {
      saved[key] = settings[key];
      settings[key] = style[key];
    }
    try {
      return fn();
    } finally {
      Object.assign(settings, saved);
    }
  };
  // 拼出的块按同一解析器解析回来须与当前块(们)写法相同
  const roundTripsAll = (markdown: string, nodes: readonly PmNode[]): boolean => {
    try {
      const kids = blockChildren(ctx.get(parserCtx)(markdown) as PmNode);
      return kids.length === nodes.length && kids.every((kid, i) => sameBlock(kid, nodes[i]!));
    } catch {
      return false;
    }
  };
  const roundTrips = (markdown: string, node: PmNode): boolean => roundTripsAll(markdown, [node]);
  const { source } = bound;
  return {
    // 拆分 / 合并 / 新建的块整段走 remark:同样试解析,不同则依次退回保留行内代码换行、保守写法(与 one 的安全网同口径;
    // 如拆段后新段里跨行的行内代码,remark 默认把其中的换行换成空格,行内代码的内容就变了)
    run: (nodes) => {
      const plain = write(nodes);
      if (roundTripsAll(plain, nodes)) return plain;
      for (const fallback of RUN_FALLBACKS) {
        const out = withStyle(fallback, () => write(nodes));
        if (roundTripsAll(out, nodes)) return out;
      }
      return plain;
    },
    one: (node, cp) => {
      // 表格不就地改:对齐的表格改了列宽要整表重排(serializeTable)
      const spliced = node.type.name === 'table' ? null : spliceText(source, cp, node, roundTrips);
      if (spliced !== null) return spliced;
      cp.style ??= inferMarkdownStyleParts(cp.md, source);
      const style = cp.style;
      const styled = withStyle(style, () => {
        const plain = write([node]);
        const deep = node.type.name === 'table' || isList(node);
        if (!deep) return plain;
        if (cp.children === undefined) cp.children = pairLevel(cp.node, cp.md, source, cp.from, cp.to);
        const level = cp.children;
        if (!level) return plain;
        const custom =
          node.type.name === 'table'
            ? serializeTable(source, level, node, plain)
            : serializeList(cp, level, node, source, (list) => write([list]));
        return custom !== null && custom !== plain && roundTrips(custom, node) ? custom : plain;
      });
      if (roundTrips(styled, node)) return styled;
      // 安全网:按原文写法(块风格推断、裸链接、`$` 不转义……)写出的块解析回来与当前块不同 → 依次退回:同写法但保留行内代码里的
      // 换行、全文风格的 remark 默认写法、保守写法(`<url>`、`$` 与反引号一律转义;再加保留换行);都不行仍用原文写法
      const fallbacks: ReadonlyArray<Readonly<Record<string, unknown>>> = [
        { ...style, continuoInlineCodeEol: 'keep' },
        {},
        SAFE_STYLE,
        { ...SAFE_STYLE, continuoInlineCodeEol: 'keep' },
      ];
      for (const fallback of fallbacks) {
        const out = withStyle(fallback, () => write([node]));
        if (roundTrips(out, node)) return out;
      }
      return styled;
    },
  };
}

function bind(tree: MdNode, source: string, doc: PmNode): Bound | null {
  const level = pairLevel(doc, tree, source, 0, source.length);
  return level ? { source, level } : null;
}

export interface MarkdownSourceBlocks {
  /** 用编辑器的解析器解析外部内容(顺带记下 mdast,供随后的 resync 用,不再解析一次)。 */
  parse(markdown: string): unknown;
  /** 编辑器内容同步后重建原文块与行尾(视图文档已是 `markdown` 的内容)。 */
  resync(markdown: string): void;
}

/** 在 crepe.create() 之前调用(configureMarkdownStyle 之后):按初始内容 `source` 原样写回未改动的块、跟随其行尾。 */
export function configureSourceBlocks(crepe: Crepe, source: string): MarkdownSourceBlocks {
  const editor = crepe.editor;
  let captured: MdNode | null = null;
  let bound: Bound | null = null;
  let eol = detectLineEnding(source);
  let ctxRef: Ctx | null = null; // 插件装上即有(解析器在 ParserReady 后可用)
  let ready: Ctx | null = null; // 挂载时的原文块已建好
  // 要记下解析结果的内容:挂载时 = 初始内容(Milkdown 对它的那次解析);之后只在 parse() 期间设
  let capturing: string | null = source;
  editor.use(
    $remark('continuoSourceBlocks', () => function continuoSourceBlocks() {
      return (tree: MdNode, file: { value?: unknown }) => {
        if (capturing !== null && file.value === capturing) {
          captured = tree;
          capturing = null;
        }
      };
    }),
  );
  const plugin: MilkdownPlugin = (ctx) => {
    ctxRef = ctx;
    return async () => {
      await ctx.wait(SerializerReady);
      const base = ctx.get(serializerCtx) as unknown as Serializer;
      const serialize: Serializer = (doc) => {
        let out: string;
        try {
          out = bound ? assemble(bound, blockChildren(doc), createSerializers(ctx, bound, base)) : base(doc);
        } catch {
          out = base(doc);
        }
        return eol === '\r\n' ? convertLineEndings(out, 'CRLF') : out;
      };
      ctx.set(serializerCtx, serialize as never);
      await ctx.wait(EditorStateReady);
      const tree = captured;
      captured = null;
      if (tree) bound = bind(tree, source, ctx.get(editorStateCtx).doc as unknown as PmNode);
      ready = ctx;
    };
  };
  editor.use(plugin);
  let parsed: { readonly markdown: string; readonly tree: MdNode } | null = null;
  return {
    parse: (markdown) => {
      if (!ctxRef) throw new Error('editor not created');
      if (!ready) return ctxRef.get(parserCtx)(markdown); // 挂载前:不动挂载时那次记录
      captured = null;
      capturing = markdown;
      try {
        return ctxRef.get(parserCtx)(markdown);
      } finally {
        capturing = null;
        parsed = captured ? { markdown, tree: captured } : null;
        captured = null;
      }
    },
    resync: (markdown) => {
      eol = detectLineEnding(markdown);
      const ctx = ready;
      if (!ctx) return;
      try {
        let tree = parsed?.markdown === markdown ? parsed.tree : null;
        if (!tree) {
          const remark = ctx.get(remarkCtx) as unknown as ProcessorLike;
          tree = remark.runSync(remark.parse(markdown), markdown) as MdNode;
        }
        bound = bind(tree, markdown, ctx.get(editorViewCtx).state.doc as unknown as PmNode);
      } catch {
        bound = null;
      }
      parsed = null;
    },
  };
}
