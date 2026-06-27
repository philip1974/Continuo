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

const EMPTY_FILTERED_MARKETPLACE_ENTRIES: readonly MarketplaceEntry[] = [];
const EMPTY_MARKETPLACE_ENTRY_TAGS: readonly string[] = [];

function entryTags(entry: MarketplaceEntry): readonly string[] {
  return entry.tags ?? EMPTY_MARKETPLACE_ENTRY_TAGS;
}

/** 应用过滤,返回保留的 entries(原顺序). */
export function applyFilter(
  entries: readonly MarketplaceEntry[],
  opts: FilterOptions,
): readonly MarketplaceEntry[] {
  if (entries.length === 0) return entries;
  // 边界(E281):filter 层防御性截断 query(applyFilter 是导出纯函数,可被非 UI 调用方传超长 query
  // → 对 ≤4096 entry 逐项 includes 放大)。与 onChange clamp 同一上限,双层防护。
  const q = clampSearchQuery(opts.query).trim().toLowerCase();
  const hasQuery = q.length > 0;
  const hasTags = opts.selectedTags.size > 0;
  if (!hasQuery && !hasTags) return entries;

  let filtered: MarketplaceEntry[] | null = null;
  let count = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const keep =
      (!hasQuery || matchQuery(entry, q)) &&
      (!hasTags || matchTags(entry, opts.selectedTags));
    if (keep) {
      if (filtered !== null) filtered[count] = entry;
      count++;
      continue;
    }
    if (filtered === null) {
      filtered = new Array<MarketplaceEntry>(entries.length - 1);
      for (let j = 0; j < count; j++) filtered[j] = entries[j]!;
    }
  }
  if (filtered === null) return entries;
  filtered.length = count;
  return count === 0 ? EMPTY_FILTERED_MARKETPLACE_ENTRIES : filtered;
}

export function buildMarketplaceSearchHaystack(entry: MarketplaceEntry): string {
  let haystack = `${entry.name} ${entry.id} ${entry.description ?? ''}`;
  for (const tag of entryTags(entry)) {
    haystack += ` ${tag}`;
  }
  return haystack.toLowerCase();
}

function matchQuery(entry: MarketplaceEntry, q: string): boolean {
  if (q.length === 0) return true;
  if (entry.name.toLowerCase().includes(q)) return true;
  if (entry.id.toLowerCase().includes(q)) return true;
  if (entry.description && entry.description.toLowerCase().includes(q)) {
    return true;
  }
  for (const tag of entryTags(entry)) {
    if (tag.toLowerCase().includes(q)) return true;
  }
  return false;
}

function matchTags(
  entry: MarketplaceEntry,
  selected: ReadonlySet<string>,
): boolean {
  if (selected.size === 0) return true;
  const tags = entryTags(entry);
  for (const tag of tags) {
    if (selected.has(tag)) return true;
  }
  return false;
}

// 边界(E226,E210 逐项≠累计上限族):全局 distinct tag 数上限。单 entry tags 有上限、index entries 有
// 上限(4096),但二者相乘最坏数十万 distinct tags —— 畸形远程 index 否则在 collectAllTags 收集/排序 +
// UI 渲染全部 tag 按钮处卡 renderer。凑满 MAX_MARKETPLACE_TAGS 即停收集(只渲染限度内集合)。
export const MAX_MARKETPLACE_TAGS = 256;
const EMPTY_MARKETPLACE_TAGS: readonly string[] = [];

/** 索引去重收集所有 tags(按字典序),全局 distinct 数封顶 MAX_MARKETPLACE_TAGS(E226). */
export function collectAllTags(
  entries: readonly MarketplaceEntry[],
): readonly string[] {
  if (entries.length === 0) return EMPTY_MARKETPLACE_TAGS;
  let set: Set<string> | undefined;
  let tags: string[] | undefined;
  let count = 0;
  let prevTag = '';
  let sorted = true;
  outer: for (const e of entries) {
    for (const t of entryTags(e)) {
      if (!set || !tags) {
        set = new Set<string>();
        tags = new Array<string>(MAX_MARKETPLACE_TAGS);
      }
      if (set.has(t)) continue;
      set.add(t);
      if (count > 0 && prevTag.localeCompare(t) > 0) sorted = false;
      prevTag = t;
      tags[count++] = t;
      if (set.size >= MAX_MARKETPLACE_TAGS) break outer; // 全局 tag 数到顶,停止收集
    }
  }
  if (!tags) return EMPTY_MARKETPLACE_TAGS;
  tags.length = count;
  if (count < 2) return tags;
  return sorted ? tags : tags.sort((a, b) => a.localeCompare(b));
}
