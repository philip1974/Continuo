// Markdown 源码行 ↔ Milkdown(ProseMirror)文档位置的近似映射:切换 源码 / 编辑 / 预览 时保留阅读位置与光标所在行
//(VSCode:Markdown 预览与编辑器按源码行同步滚动,预览元素带 data-line)。BDD: src/__tests__/markdown-mode-position/
//
// ProseMirror 文档不保留源码位置。做法:用 Milkdown 自己的 remark 处理器(slice 'remark',与它建文档同一套解析 +
// 插件)把同一份 markdown 解析成带行号的 mdast,与 ProseMirror 文档按「同层第 i 个子节点」同步下钻 —— 块级结构
//(段落 / 标题 / 列表 / 列表项 / 引用 / 代码块 / 表格行)两边一一对应,定位到最深的块:
//   - 精度:块级。块内按比例插值(源码行数 × 可见比例);代码块内按换行精确到行。
//   - 不对应时(Milkdown 不建节点的结构,如链接引用定义;预览把 frontmatter 换成代码块多出 1 行)退化为就近块,
//     偏差在一两个块 / 一行以内。

/** mdast 节点(只用到的部分)。 */
export interface MdNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly MdNode[];
  readonly position?: { readonly start: { readonly line: number }; readonly end: { readonly line: number } };
}

/** ProseMirror 节点(只用到的部分;@milkdown/kit 非直接依赖,结构化类型)。 */
export interface PmNode {
  readonly childCount: number;
  child(index: number): PmNode;
  readonly nodeSize: number;
  readonly isTextblock: boolean;
  readonly type: { readonly name: string };
  readonly textContent: string;
  /** 文本节点的文字(行内子节点按此取块正文;其它行内节点占位)。 */
  readonly isText?: boolean;
  readonly text?: string;
}

/** Milkdown 不为其建 ProseMirror 节点的 mdast 块(链接引用定义),同层对齐时跳过。 */
const UNMAPPED_TYPES = new Set(['definition']);

function mdChildren(node: MdNode): readonly MdNode[] {
  const kids = node.children ?? [];
  return kids.some((k) => UNMAPPED_TYPES.has(k.type)) ? kids.filter((k) => !UNMAPPED_TYPES.has(k.type)) : kids;
}

function startLine(md: MdNode): number {
  return md.position?.start.line ?? 1;
}

/** 块占的源码行数(≥1)。 */
function lineSpan(md: MdNode): number {
  return md.position ? Math.max(1, md.position.end.line - md.position.start.line + 1) : 1;
}

/** 围栏代码块(``` / ~~~):正文首行在起始行下一行。按行数判断(围栏比正文多两行)。 */
function codeBodyStartLine(md: MdNode): number {
  const bodyLines = md.value === undefined ? 0 : md.value.split('\n').length;
  return lineSpan(md) >= bodyLines + 2 ? startLine(md) + 1 : startLine(md);
}

function isCode(pm: PmNode, md: MdNode): boolean {
  return pm.type.name === 'code_block' && md.type === 'code';
}

export interface LocatedBlock {
  /** 块在 ProseMirror 文档里的起始位置(节点之前;`view.nodeDOM` 的参数)。 */
  readonly before: number;
  readonly pm: PmNode;
  readonly md: MdNode;
}

/**
 * 源码行 → 包含它的最深块(文本块或叶子块)。行落在块间空行时取下一个块。同一行有多个同层块(表格行的单元格)时取最后一个;
 * firstOnLine = 取第一个(在文件中查找定位从行首数起)。
 */
export function locateSourceLine(doc: PmNode, tree: MdNode, line: number, firstOnLine = false): LocatedBlock | null {
  let pm = doc;
  let md = tree;
  let contentStart = 0;
  let found: LocatedBlock | null = null;
  while (!pm.isTextblock && pm.childCount > 0) {
    const kids = mdChildren(md);
    if (kids.length === 0) break;
    let i = 0;
    for (let k = 0; k < kids.length && startLine(kids[k]!) <= line; k++) {
      if (firstOnLine && k > 0 && startLine(kids[k]!) === startLine(kids[i]!)) continue;
      i = k;
    }
    const cur = kids[i]!;
    if (cur.position && line > cur.position.end.line && i + 1 < kids.length) i += 1;
    const index = Math.min(i, pm.childCount - 1);
    let before = contentStart;
    for (let k = 0; k < index; k++) before += pm.child(k).nodeSize;
    pm = pm.child(index);
    md = kids[i]!;
    found = { before, pm, md };
    contentStart = before + 1;
  }
  return found;
}

/** 位置所在的最深块,及位置在该块正文里的偏移(块本身之前的位置偏移为 -1)。 */
function blockAtPos(doc: PmNode, tree: MdNode, pos: number): { block: LocatedBlock; offset: number } | null {
  let pm = doc;
  let md = tree;
  let contentStart = 0;
  let found: { block: LocatedBlock; offset: number } | null = null;
  while (!pm.isTextblock && pm.childCount > 0) {
    const kids = mdChildren(md);
    if (kids.length === 0) break;
    let before = contentStart;
    let k = 0;
    for (; k < pm.childCount - 1 && pos >= before + pm.child(k).nodeSize; k++) before += pm.child(k).nodeSize;
    pm = pm.child(k);
    md = kids[Math.min(k, kids.length - 1)]!;
    found = { block: { before, pm, md }, offset: pos - before - 1 };
    if (pos <= before) break;
    contentStart = before + 1;
  }
  return found;
}

/** ProseMirror 位置(如光标)→ 源码行:块起始行;代码块内按换行精确到行。 */
export function sourceLineAtPos(doc: PmNode, tree: MdNode, pos: number): number {
  const hit = blockAtPos(doc, tree, pos);
  if (!hit) return 1;
  const { pm, md } = hit.block;
  if (isCode(pm, md) && hit.offset >= 0) {
    const newlines = pm.textContent.slice(0, hit.offset).split('\n').length - 1;
    return codeBodyStartLine(md) + newlines;
  }
  return startLine(md);
}

/** 源码行 → 光标位置(块正文起点;代码块内到对应行首)。 */
export function posForSourceLine(doc: PmNode, tree: MdNode, line: number): number | null {
  const block = locateSourceLine(doc, tree, line);
  if (!block) return null;
  const contentStart = block.before + 1;
  if (isCode(block.pm, block.md)) {
    const lines = block.pm.textContent.split('\n');
    const target = Math.min(Math.max(0, line - codeBodyStartLine(block.md)), lines.length - 1);
    let offset = 0;
    for (let i = 0; i < target; i++) offset += lines[i]!.length + 1;
    return contentStart + offset;
  }
  return contentStart;
}

/** 文本块正文:下标与文档位置一一对应(文本节点取文字;图片 / 换行等行内节点按其大小记占位符,同 markdown-find)。 */
function textblockText(block: PmNode): string {
  let text = '';
  for (let i = 0; i < block.childCount; i++) {
    const child = block.child(i);
    text += child.isText && child.text !== undefined ? child.text : '\uFFFC'.repeat(child.nodeSize);
  }
  return text;
}

/** 按 mdast 同步下钻的文档顺序遍历文本块(带各自的 mdast 节点);visit 返回 false 即停。 */
function eachTextblock(pm: PmNode, md: MdNode, contentStart: number, visit: (before: number, pm: PmNode, md: MdNode) => boolean): boolean {
  const kids = mdChildren(md);
  let before = contentStart;
  for (let k = 0; k < pm.childCount; k++) {
    const child = pm.child(k);
    const childMd = kids[Math.min(k, kids.length - 1)] ?? md;
    if (child.isTextblock) {
      if (!visit(before, child, childMd)) return false;
    } else if (child.childCount > 0 && !eachTextblock(child, childMd, before + 1, visit)) {
      return false;
    }
    before += child.nodeSize;
  }
  return true;
}

/** needle 在 text 里不重叠出现的起点。 */
function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/**
 * 源码里的一处匹配(行 / 列 1 起、长度,均为 UTF-16;在文件中查找的结果)→ 文档里的对应范围(打开结果时选中它)。
 * 源码与渲染后的正文不一一对应(标记符号、链接地址、转义),故按「同一段文字的第几次出现」对齐:定位匹配所在的块(表格行
 * 取行首的单元格),数源码里从该块起(代码块从正文首行起)到匹配前这段文字出现过几次,在文档里从该块起(只看起始行不晚于
 * 匹配行的文本块)找同一序号的出现。出现次数不够(前面的出现在标记 / 链接地址里)→ 取最后一次;正文里没有这段文字(匹配落在
 * 标记 / 地址里)或未给长度 → 光标放到块起点。行号超出源码 → null。
 */
export function rangeForSourceMatch(
  doc: PmNode,
  tree: MdNode,
  markdown: string,
  line: number,
  column?: number,
  length?: number,
): { from: number; to: number } | null {
  const lines = markdown.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
  const block = locateSourceLine(doc, tree, line, true);
  if (!block) return null;
  const fallback = posForSourceLine(doc, tree, line) ?? block.before + 1;
  const lineText = lines[line - 1]!;
  const col = column !== undefined && Number.isInteger(column) && column > 1 ? Math.min(column - 1, lineText.length) : 0;
  const needle = length !== undefined && Number.isInteger(length) && length > 0 ? lineText.slice(col, col + length) : '';
  if (!needle) return { from: fallback, to: fallback };
  const blockStart = startLine(block.md);
  const countFrom = isCode(block.pm, block.md) ? codeBodyStartLine(block.md) : blockStart;
  const preceding = [...lines.slice(countFrom - 1, line - 1), lineText.slice(0, col)].join('\n');
  const candidates: Array<{ readonly before: number; readonly pm: PmNode }> = [];
  eachTextblock(doc, tree, 0, (before, pm, md) => {
    if (before < block.before) return true;
    if (startLine(md) > line) return false;
    candidates.push({ before, pm });
    return true;
  });
  let remaining = occurrences(preceding, needle).length;
  let from: number | null = null;
  for (const { before, pm } of candidates) {
    const found = occurrences(textblockText(pm), needle);
    if (found.length === 0) continue;
    if (remaining < found.length) {
      from = before + 1 + found[remaining]!;
      break;
    }
    remaining -= found.length;
    from = before + 1 + found[found.length - 1]!;
  }
  return from === null ? { from: fallback, to: fallback } : { from, to: from + needle.length };
}

/** 块内比例(0..1,块可见顶部之上已滚过的比例)→ 源码行。 */
export function sourceLineInBlock(md: MdNode, fraction: number): number {
  const f = Math.min(Math.max(fraction, 0), 0.999);
  return startLine(md) + Math.floor(f * lineSpan(md));
}

/** 源码行在块内的比例(sourceLineInBlock 的逆)。 */
export function fractionOfLineInBlock(md: MdNode, line: number): number {
  const span = lineSpan(md);
  if (span <= 1) return 0;
  return Math.min(Math.max((line - startLine(md)) / span, 0), 1);
}

/** 解析 markdown(Milkdown 的 remark 处理器:parse + 插件,与建文档同一套)。 */
export interface RemarkLike {
  parse(markdown: string): unknown;
  runSync(tree: unknown, file?: string): unknown;
}

export function parseMarkdownTree(remark: RemarkLike, markdown: string): MdNode {
  return remark.runSync(remark.parse(markdown), markdown) as MdNode;
}

/** ProseMirror 视图(只用到 nodeDOM)。 */
export interface PmViewLike {
  nodeDOM(pos: number): Node | null;
}

/** 节点视图的外框;跨窗口(popout 子窗)的元素不是本窗口 Element 的实例,按能力判断。 */
function rectOf(dom: Node | null): DOMRect | null {
  const el = dom as Element | null;
  return el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
}

/** 视口 y = `top` 处(滚动容器顶边)可见的源码行:逐层找第一个底边越过 top 的块,块内按比例插值。 */
export function topVisibleSourceLine(doc: PmNode, tree: MdNode, view: PmViewLike, top: number): number | null {
  let pm = doc;
  let contentStart = 0;
  let hit: { before: number; rect: DOMRect } | null = null;
  while (!pm.isTextblock && pm.childCount > 0) {
    let before = contentStart;
    let next: { child: PmNode; before: number; rect: DOMRect } | null = null;
    for (let k = 0; k < pm.childCount; k++) {
      const child = pm.child(k);
      const rect = rectOf(view.nodeDOM(before));
      if (rect && rect.bottom > top) {
        next = { child, before, rect };
        break;
      }
      before += child.nodeSize;
    }
    if (!next) break;
    hit = next;
    if (next.rect.top >= top) break; // 块整个在顶边之下:就是它,不必再下钻
    pm = next.child;
    contentStart = next.before + 1;
  }
  if (!hit) return null;
  const md = blockAtPos(doc, tree, hit.before)?.block.md;
  if (!md) return null;
  const fraction = hit.rect.height > 0 ? (top - hit.rect.top) / hit.rect.height : 0;
  return sourceLineInBlock(md, fraction);
}

/** 源码行在视口里的 y(块顶边 + 块内比例);滚动容器据此把该行滚到顶边。 */
export function viewportYOfSourceLine(doc: PmNode, tree: MdNode, view: PmViewLike, line: number): number | null {
  const block = locateSourceLine(doc, tree, line);
  if (!block) return null;
  const rect = rectOf(view.nodeDOM(block.before));
  if (!rect) return null;
  return rect.top + fractionOfLineInBlock(block.md, line) * rect.height;
}
