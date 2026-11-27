// Markdown 标题符号的类型、按需加载与缓存(转到符号 ⇧⌘O / Quick Open `@` 与侧栏「大纲」共用一份)。
// 解析器(markdown-symbols,含 lezer)动态 import:Quick Open 与侧栏都在启动路径上,不把解析器拖进启动包。
// 结果按源码文本缓存(最近几份):同一文本在大纲与选择器之间、在切回 tab 时不重复解析。
// BDD: src/__tests__/markdown-outline/

export interface MarkdownSymbol {
  /** VSCode 同:`## 标题`。 */
  readonly name: string;
  /** 标题纯文本(过滤 / 排序 / 读屏用)。 */
  readonly text: string;
  /** 1–6。 */
  readonly level: number;
  /** 标题起始的源码行(1 起;setext 为文字首行)。 */
  readonly line: number;
  /** 节的最后一行(1 起,含)。 */
  readonly endLine: number;
  /** 在全文标题中的序号(文档顺序,0 起;编辑 / 预览视图按它找对应的标题节点)。 */
  readonly ordinal: number;
  readonly children: readonly MarkdownSymbol[];
}

export interface MarkdownOutline {
  /** 顶层符号(树)。 */
  readonly roots: readonly MarkdownSymbol[];
  /** 全部符号,文档顺序(flat[i].ordinal === i)。 */
  readonly flat: readonly MarkdownSymbol[];
}

export const EMPTY_OUTLINE: MarkdownOutline = { roots: [], flat: [] };

/**
 * 源码行 line 所在的节 = 不晚于该行的最后一个标题(它也是包含该行的最深的节);在第一个标题之前 → -1。
 */
export function symbolOrdinalAtLine(outline: MarkdownOutline, line: number): number {
  const { flat } = outline;
  let lo = 0;
  let hi = flat.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flat[mid]!.line <= line) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

type Parse = (source: string) => MarkdownOutline;

let parserModule: Promise<Parse> | null = null;

function loadParser(): Promise<Parse> {
  parserModule ??= import('./markdown-symbols').then(
    (m) => m.parseMarkdownSymbols,
    (err: unknown) => {
      parserModule = null; // 失败不缓存,下次再试
      throw err;
    },
  );
  return parserModule;
}

/** 缓存的份数(大纲 + 选择器 + 切回的 tab)。 */
const CACHE_SIZE = 4;
const cache = new Map<string, MarkdownOutline>();

/** 已解析过的同一文本 → 结果;否则 undefined(调用方据此决定是否显示「加载中」或沿用旧结果)。 */
export function cachedMarkdownOutline(source: string): MarkdownOutline | undefined {
  const hit = cache.get(source);
  if (hit !== undefined) {
    cache.delete(source);
    cache.set(source, hit);
  }
  return hit;
}

/** 源码文本的标题符号(首次调用加载解析器)。 */
export async function markdownOutlineOf(source: string): Promise<MarkdownOutline> {
  const hit = cachedMarkdownOutline(source);
  if (hit !== undefined) return hit;
  const parse = await loadParser();
  const outline = parse(source);
  cache.set(source, outline);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return outline;
}
