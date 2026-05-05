// 插件商店筛选 + 搜索(Phase 4)。
//
// 纯函数,易测。entries → 经过 query (name/desc/tag 包含) + 选中 tags (any)
// 双重过滤;空 query / 空 tag 选择视为 pass。

import type { MarketplaceEntry } from './types';

export interface FilterOptions {
  /** 大小写不敏感子串匹配,空串 = pass. */
  readonly query: string;
  /** 选中的 tag 集合,空 = pass;非空 = entry.tags 与之有任一交集. */
  readonly selectedTags: ReadonlySet<string>;
}

/** 应用过滤,返回保留的 entries(原顺序). */
export function applyFilter(
  entries: readonly MarketplaceEntry[],
  opts: FilterOptions,
): readonly MarketplaceEntry[] {
  const q = opts.query.trim().toLowerCase();
  return entries.filter((e) => matchQuery(e, q) && matchTags(e, opts.selectedTags));
}

function matchQuery(entry: MarketplaceEntry, q: string): boolean {
  if (q.length === 0) return true;
  const haystack = [
    entry.name,
    entry.id,
    entry.description ?? '',
    ...(entry.tags ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

function matchTags(
  entry: MarketplaceEntry,
  selected: ReadonlySet<string>,
): boolean {
  if (selected.size === 0) return true;
  const tags = entry.tags ?? [];
  return tags.some((t) => selected.has(t));
}

/** 索引去重收集所有 tags(按字典序). */
export function collectAllTags(
  entries: readonly MarketplaceEntry[],
): readonly string[] {
  const set = new Set<string>();
  for (const e of entries) {
    for (const t of e.tags ?? []) set.add(t);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
