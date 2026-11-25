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

/** 源码行 → 包含它的最深块(文本块或叶子块)。行落在块间空行时取下一个块。 */
export function locateSourceLine(doc: PmNode, tree: MdNode, line: number): LocatedBlock | null {
  let pm = doc;
  let md = tree;
  let contentStart = 0;
  let found: LocatedBlock | null = null;
  while (!pm.isTextblock && pm.childCount > 0) {
    const kids = mdChildren(md);
    if (kids.length === 0) break;
    let i = 0;
    for (let k = 0; k < kids.length && startLine(kids[k]!) <= line; k++) i = k;
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
