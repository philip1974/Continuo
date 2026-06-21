// 评论拉取(doc/15 Phase 1)。
//
// 安全 S4(codex 安全审计):token + GitHub GraphQL fetch 已移到 **main 进程**
// (electron/main/services/marketplace-reviews.service.ts),token 走运行时 GITHUB_TOKEN
// env,绝不内联进 renderer 产物。本文件(renderer)只经 IPC 拿聚合前的 discussion
// nodes,做 parse/aggregate + sessionStorage 缓存,**接触不到 token**。
//
// 旧实现用 Vite 的 VITE_(GITHUB_TOKEN) 注入直连 GitHub —— Vite 会把 VITE_* 前缀变量
// 内联进产物,任何 renderer 内插件 / 拿到打包应用的人都能提取该 token(已修)。
//
// 缓存:1h sessionStorage 同 marketplace index 模式。

import { coApi } from '../lib/co-api';
import { parseReview } from './reviews-parser';
import type { PluginAggregateRating, Review } from './reviews-types';

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_KEY = 'continuo:marketplace:reviews';

interface CachedReviews {
  readonly fetchedAt: number;
  readonly byPid: Record<string, PluginAggregateRating>;
}

let memoryCache: CachedReviews | null = null;

function readSessionCache(): CachedReviews | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedReviews;
    if (typeof parsed.fetchedAt !== 'number' || !parsed.byPid) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSessionCache(cache: CachedReviews): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* */
  }
}

/**
 * 拉所有 reviews,按 plugin id 聚合。token + 网络在 main(IPC)。
 *
 * - cache 新鲜 且非 force → 走 cache
 * - main 无 GITHUB_TOKEN(available:false)→ 有 cache 返 cache,否则抛 NO_TOKEN
 * - 网络/IPC 失败 → 退守 cache;无 cache 抛
 * - forceRefresh → 跳 cache 强拉
 */
export async function fetchAllReviews(
  forceRefresh = false,
): Promise<ReadonlyMap<string, PluginAggregateRating>> {
  if (!memoryCache) memoryCache = readSessionCache();
  if (
    !forceRefresh &&
    memoryCache &&
    Date.now() - memoryCache.fetchedAt < CACHE_TTL_MS
  ) {
    return new Map(Object.entries(memoryCache.byPid));
  }

  let res: Awaited<ReturnType<typeof coApi.marketplace.fetchReviews>>;
  try {
    res = await coApi.marketplace.fetchReviews();
  } catch (err) {
    if (memoryCache) {
      console.warn('[reviews] IPC failed, falling back to cache', err);
      return new Map(Object.entries(memoryCache.byPid));
    }
    throw err;
  }

  if (!res.ok) {
    if (memoryCache) {
      console.warn('[reviews] fetch failed, falling back to cache', res.message);
      return new Map(Object.entries(memoryCache.byPid));
    }
    throw new Error(res.message);
  }

  if (!res.data.available) {
    if (memoryCache) return new Map(Object.entries(memoryCache.byPid));
    throw new Error('NO_TOKEN: GITHUB_TOKEN 未在 main 配置');
  }

  const reviews: Review[] = [];
  for (const node of res.data.nodes) {
    const parsed = parseReview(node);
    if (parsed) reviews.push(parsed);
  }
  const byPid = aggregate(reviews);
  const next: CachedReviews = {
    fetchedAt: Date.now(),
    byPid: Object.fromEntries(byPid),
  };
  memoryCache = next;
  writeSessionCache(next);
  return byPid;
}

function aggregate(
  reviews: readonly Review[],
): Map<string, PluginAggregateRating> {
  const groups = new Map<string, Review[]>();
  for (const r of reviews) {
    if (!groups.has(r.pluginId)) groups.set(r.pluginId, []);
    groups.get(r.pluginId)!.push(r);
  }
  const out = new Map<string, PluginAggregateRating>();
  for (const [pluginId, rs] of groups) {
    const sum = rs.reduce((s, r) => s + r.rating, 0);
    out.set(pluginId, {
      pluginId,
      count: rs.length,
      avg: sum / rs.length,
      reviews: rs, // 已按 createdAt DESC(GraphQL orderBy)
    });
  }
  return out;
}

/** 测试用:重置 cache. */
export function _resetReviewsCacheForTest(): void {
  memoryCache = null;
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    /* */
  }
}
