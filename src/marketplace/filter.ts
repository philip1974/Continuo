// 插件商店筛选 + 搜索(Phase 4)。
//
// 纯函数,易测。entries → 经过 query (name/desc/tag 包含) + 选中 tags (any)
// 双重过滤;空 query / 空 tag 选择视为 pass。

import type { MarketplaceEntry } from './types';
import { clampSearchQuery } from '@/lib/search-query';

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
  // 边界(E281):filter 层防御性截断 query(applyFilter 是导出纯函数,可被非 UI 调用方传超长 query
  // → 对 ≤4096 entry 逐项 includes 放大)。与 onChange clamp 同一上限,双层防护。
  const q = clampSearchQuery(opts.query).trim().toLowerCase();
  const hasQuery = q.length > 0;
  const hasTags = opts.selectedTags.size > 0;
  if (!hasQuery && !hasTags) return entries;

  const filtered = new Array<MarketplaceEntry>(entries.length);
  let count = 0;
  for (const entry of entries) {
    if (hasQuery && !matchQuery(entry, q)) continue;
    if (hasTags && !matchTags(entry, opts.selectedTags)) continue;
    filtered[count++] = entry;
  }
  filtered.length = count;
  return filtered;
}

export function buildMarketplaceSearchHaystack(entry: MarketplaceEntry): string {
  let haystack = `${entry.name} ${entry.id} ${entry.description ?? ''}`;
  for (const tag of entry.tags ?? []) {
    haystack += ` ${tag}`;
  }
  return haystack.toLowerCase();
}

function matchQuery(entry: MarketplaceEntry, q: string): boolean {
  if (q.length === 0) return true;
  return buildMarketplaceSearchHaystack(entry).includes(q);
}

function matchTags(
  entry: MarketplaceEntry,
  selected: ReadonlySet<string>,
): boolean {
  if (selected.size === 0) return true;
  const tags = entry.tags ?? [];
  for (const tag of tags) {
    if (selected.has(tag)) return true;
  }
  return false;
}

// 边界(E226,E210 逐项≠累计上限族):全局 distinct tag 数上限。单 entry tags 有上限、index entries 有
// 上限(4096),但二者相乘最坏数十万 distinct tags —— 畸形远程 index 否则在 collectAllTags 收集/排序 +
// UI 渲染全部 tag 按钮处卡 renderer。凑满 MAX_MARKETPLACE_TAGS 即停收集(只渲染限度内集合)。
export const MAX_MARKETPLACE_TAGS = 256;

/** 索引去重收集所有 tags(按字典序),全局 distinct 数封顶 MAX_MARKETPLACE_TAGS(E226). */
export function collectAllTags(
  entries: readonly MarketplaceEntry[],
): readonly string[] {
  const set = new Set<string>();
  const tags = new Array<string>(MAX_MARKETPLACE_TAGS);
  let count = 0;
  outer: for (const e of entries) {
    for (const t of e.tags ?? []) {
      if (set.has(t)) continue;
      set.add(t);
      tags[count++] = t;
      if (set.size >= MAX_MARKETPLACE_TAGS) break outer; // 全局 tag 数到顶,停止收集
    }
  }
  tags.length = count;
  return tags.sort((a, b) => a.localeCompare(b));
}
