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

interface MarketplaceSearchCache {
  idSource?: string;
  idLower?: string;
  nameSource?: string;
  nameLower?: string;
  descriptionReady?: boolean;
  descriptionSource?: string;
  descriptionLower?: string;
  tagsSource?: readonly string[];
  tagsLower?: readonly string[];
}

const marketplaceSearchCache = new WeakMap<
  MarketplaceEntry,
  MarketplaceSearchCache
>();

function entryTags(entry: MarketplaceEntry): readonly string[] {
  return entry.tags ?? EMPTY_MARKETPLACE_ENTRY_TAGS;
}

function searchCacheFor(entry: MarketplaceEntry): MarketplaceSearchCache {
  let cache = marketplaceSearchCache.get(entry);
  if (cache === undefined) {
    cache = {};
    marketplaceSearchCache.set(entry, cache);
  }
  return cache;
}

function lowerIfNeeded(value: unknown): string {
  if (typeof value !== 'string') {
    return (value as { toLowerCase: () => string }).toLowerCase();
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code >= 65 && code <= 90) || code > 127) {
      return value.toLowerCase();
    }
  }
  return value;
}

function lowerName(entry: MarketplaceEntry): string {
  const cache = searchCacheFor(entry);
  const value = entry.name;
  if (cache.nameSource !== value) {
    cache.nameSource = value;
    cache.nameLower = lowerIfNeeded(value);
  }
  return cache.nameLower!;
}

function lowerId(entry: MarketplaceEntry): string {
  const cache = searchCacheFor(entry);
  const value = entry.id;
  if (cache.idSource !== value) {
    cache.idSource = value;
    cache.idLower = lowerIfNeeded(value);
  }
  return cache.idLower!;
}

function lowerDescription(entry: MarketplaceEntry): string {
  const cache = searchCacheFor(entry);
  const value = entry.description;
  if (!cache.descriptionReady || cache.descriptionSource !== value) {
    cache.descriptionReady = true;
    cache.descriptionSource = value;
    cache.descriptionLower = value === undefined ? '' : lowerIfNeeded(value);
  }
  return cache.descriptionLower!;
}

function lowerTags(entry: MarketplaceEntry): readonly string[] {
  const cache = searchCacheFor(entry);
  const tags = entryTags(entry);
  if (cache.tagsSource !== tags) {
    if (tags.length === 0) {
      cache.tagsSource = tags;
      cache.tagsLower = EMPTY_MARKETPLACE_ENTRY_TAGS;
      return cache.tagsLower;
    }
    const lower = new Array<string>(tags.length);
    for (let i = 0; i < tags.length; i++) {
      lower[i] = lowerIfNeeded(tags[i]!);
    }
    cache.tagsSource = tags;
    cache.tagsLower = lower;
  }
  return cache.tagsLower!;
}

/** 应用过滤,返回保留的 entries(原顺序). */
export function applyFilter(
  entries: readonly MarketplaceEntry[],
  opts: FilterOptions,
): readonly MarketplaceEntry[] {
  if (entries.length === 0) return entries;
  // 边界(E281):filter 层防御性截断 query(applyFilter 是导出纯函数,可被非 UI 调用方传超长 query
  // → 对 ≤4096 entry 逐项 includes 放大)。与 onChange clamp 同一上限,双层防护。
  const q = lowerIfNeeded(clampSearchQuery(opts.query).trim());
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
  let haystack = `${lowerName(entry)} ${lowerId(entry)} ${lowerDescription(entry)}`;
  for (const tag of lowerTags(entry)) {
    haystack += ` ${tag}`;
  }
  return haystack;
}

function matchQuery(entry: MarketplaceEntry, q: string): boolean {
  if (q.length === 0) return true;
  if (lowerName(entry).includes(q)) return true;
  if (lowerId(entry).includes(q)) return true;
  if (lowerDescription(entry).includes(q)) return true;
  const tags = lowerTags(entry);
  for (let i = 0; i < tags.length; i++) {
    if (tags[i]!.includes(q)) return true;
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
