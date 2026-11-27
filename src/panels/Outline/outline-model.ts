// 侧栏「大纲」视图的纯逻辑(对齐 VSCode outline 视图):符号树 → 可见行(折叠 / 过滤 / 排序)、当前节所在的可见行、树键盘导航。
// BDD: src/__tests__/markdown-outline/

import { fuzzyMatchIndices, fuzzyScore } from '@/plugins/command-palette/fuzzy';
import type { MarkdownSymbol } from '@/panels/Editor/markdown-outline-model';

/** 排序方式(VSCode outline.sortBy:position / name;Markdown 标题只有一个类别,「按类别」等同按位置,不提供)。 */
export type OutlineSortBy = 'position' | 'name';

export interface OutlineRow {
  /** 稳定 id:上级 id + 名称 + 同名序号(重新解析后折叠状态 / 键盘焦点按它保留)。 */
  readonly id: string;
  readonly symbol: MarkdownSymbol;
  /** aria-level(1 起)。 */
  readonly level: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  /** aria-posinset / aria-setsize(同级可见项中)。 */
  readonly posInSet: number;
  readonly setSize: number;
  readonly parentId: string | null;
  /** 过滤命中的下标(标题文字内);未过滤 / 仅因后代命中而保留 → null。 */
  readonly matches: readonly number[] | null;
}

export interface OutlineRowsOptions {
  readonly collapsed: ReadonlySet<string>;
  readonly filter: string;
  readonly sortBy: OutlineSortBy;
}

export interface OutlineRows {
  readonly rows: readonly OutlineRow[];
  /** 符号序号 → 行 id(含折叠 / 过滤掉的;跟随光标找可见祖先用)。 */
  readonly idOfOrdinal: ReadonlyMap<number, string>;
  /** 行 id → 上级 id。 */
  readonly parentOf: ReadonlyMap<string, string | null>;
  /** 可见行 id → 下标。 */
  readonly indexOf: ReadonlyMap<string, number>;
  /** 有子项的全部符号的行 id(含折叠 / 过滤掉的;「全部折叠」用)。 */
  readonly collapsibleIds: readonly string[];
}

/** 符号 → 稳定行 id(按文档顺序编号,与排序无关)。 */
function assignIds(roots: readonly MarkdownSymbol[]): Map<MarkdownSymbol, string> {
  const ids = new Map<MarkdownSymbol, string>();
  const walk = (list: readonly MarkdownSymbol[], parentId: string): void => {
    const seen = new Map<string, number>();
    for (const sym of list) {
      const n = seen.get(sym.name) ?? 0;
      seen.set(sym.name, n + 1);
      const id = `${parentId}/${sym.name}#${n}`;
      ids.set(sym, id);
      walk(sym.children, id);
    }
  };
  walk(roots, '');
  return ids;
}

const byName = (a: MarkdownSymbol, b: MarkdownSymbol): number =>
  a.text.localeCompare(b.text, undefined, { sensitivity: 'base', numeric: true }) || a.ordinal - b.ordinal;

/**
 * 可见行:过滤非空时只留命中项及其祖先、并忽略折叠(VSCode 过滤模式展开全部);排序按同级排(按名称 = 标题文字自然序)。
 */
export function buildOutlineRows(roots: readonly MarkdownSymbol[], opts: OutlineRowsOptions): OutlineRows {
  const filter = opts.filter;
  const rows: OutlineRow[] = [];
  const idOfOrdinal = new Map<number, string>();
  const parentOf = new Map<string, string | null>();
  const indexOf = new Map<string, number>();
  const collapsibleIds: string[] = [];
  const ids = assignIds(roots);

  // 过滤:后代命中的符号要保留(先算一遍保留集合)
  const keep = new Set<MarkdownSymbol>();
  const hits = new Map<MarkdownSymbol, readonly number[]>();
  const mark = (list: readonly MarkdownSymbol[]): boolean => {
    let any = false;
    for (const sym of list) {
      const childHit = mark(sym.children);
      const m = filter && fuzzyScore(filter, sym.text) !== null ? fuzzyMatchIndices(filter, sym.text) : null;
      if (m) hits.set(sym, m);
      if (m || childHit) {
        keep.add(sym);
        any = true;
      }
    }
    return any;
  };
  if (filter) mark(roots);

  const walk = (list: readonly MarkdownSymbol[], parentId: string | null, level: number, visible: boolean): void => {
    const ordered = opts.sortBy === 'name' ? [...list].sort(byName) : list;
    const shown = filter ? ordered.filter((s) => keep.has(s)) : ordered;
    let pos = 0;
    for (const sym of ordered) {
      const id = ids.get(sym)!;
      idOfOrdinal.set(sym.ordinal, id);
      if (sym.children.length > 0) collapsibleIds.push(id);
      parentOf.set(id, parentId);
      const isShown = visible && (!filter || keep.has(sym));
      const hasChildren = filter ? sym.children.some((c) => keep.has(c)) : sym.children.length > 0;
      const expanded = hasChildren && (filter !== '' || !opts.collapsed.has(id));
      if (isShown) {
        pos++;
        indexOf.set(id, rows.length);
        rows.push({
          id,
          symbol: sym,
          level,
          hasChildren,
          expanded,
          posInSet: pos,
          setSize: shown.length,
          parentId,
          matches: hits.get(sym) ?? null,
        });
      }
      walk(sym.children, id, level + 1, isShown && expanded);
    }
  };
  walk(roots, null, 1, true);
  return { rows, idOfOrdinal, parentOf, indexOf, collapsibleIds };
}

/**
 * 跟随光标:当前节(符号序号)所在的可见行下标 —— 该符号被折叠 / 过滤掉时取最近的可见祖先(VSCode revealActiveElement 同:
 * 不为此展开折叠的节)。没有 → -1。
 */
export function rowIndexOfOrdinal(model: OutlineRows, ordinal: number): number {
  if (ordinal < 0) return -1;
  let id: string | null | undefined = model.idOfOrdinal.get(ordinal);
  while (id) {
    const at = model.indexOf.get(id);
    if (at !== undefined) return at;
    id = model.parentOf.get(id);
  }
  return -1;
}

/** 键盘动作(VSCode 树 / 同资源管理器与搜索结果树):返回新的活动行 / 折叠切换 / 打开。 */
export type OutlineKeyAction =
  | { readonly kind: 'move'; readonly index: number }
  | { readonly kind: 'toggle'; readonly id: string; readonly expand: boolean }
  | { readonly kind: 'open'; readonly index: number }
  | null;

/**
 * ↑↓ 移动,Home / End 首尾,→ 展开(已展开 → 第一个子项),← 折叠(已折叠 / 叶子 → 上级),Enter / 空格 打开。
 * PageUp / PageDown 由调用方按可视行数处理(list-page-nav)。
 */
export function outlineKeyAction(rows: readonly OutlineRow[], active: number, key: string): OutlineKeyAction {
  if (rows.length === 0) return null;
  const cur = active < 0 ? 0 : Math.min(active, rows.length - 1);
  const row = rows[cur]!;
  switch (key) {
    case 'ArrowDown':
      return { kind: 'move', index: active < 0 ? 0 : Math.min(rows.length - 1, cur + 1) };
    case 'ArrowUp':
      return { kind: 'move', index: Math.max(0, cur - 1) };
    case 'Home':
      return { kind: 'move', index: 0 };
    case 'End':
      return { kind: 'move', index: rows.length - 1 };
    case 'ArrowRight':
      if (!row.hasChildren) return null;
      return row.expanded ? { kind: 'move', index: cur + 1 } : { kind: 'toggle', id: row.id, expand: true };
    case 'ArrowLeft': {
      if (row.hasChildren && row.expanded) return { kind: 'toggle', id: row.id, expand: false };
      if (row.parentId === null) return null;
      const parent = rows.findIndex((r) => r.id === row.parentId);
      return parent >= 0 ? { kind: 'move', index: parent } : null;
    }
    case 'Enter':
    case ' ':
      return { kind: 'open', index: cur };
    default:
      return null;
  }
}
