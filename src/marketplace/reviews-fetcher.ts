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
import { createSessionCache } from './session-cache';

// 可维护性 M19:1h sessionStorage 缓存样板复用 createSessionCache(与 index fetcher 共用)。
// 缓存的是聚合后的 byPid(plugin id → PluginAggregateRating)Record。
const reviewsCache = createSessionCache<
  Record<string, PluginAggregateRating>
>({
  key: 'continuo:marketplace:reviews',
  ttlMs: 60 * 60 * 1000,
  validate: (d): d is Record<string, PluginAggregateRating> =>
    !!d && typeof d === 'object' && !Array.isArray(d),
});

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
  if (!forceRefresh) {
    const fresh = reviewsCache.getFresh();
    if (fresh) return new Map(Object.entries(fresh));
  }

  let res: Awaited<ReturnType<typeof coApi.marketplace.fetchReviews>>;
  try {
    res = await coApi.marketplace.fetchReviews();
  } catch (err) {
    const stale = reviewsCache.getStale();
    if (stale) {
      console.warn('[reviews] IPC failed, falling back to cache', err);
      return new Map(Object.entries(stale));
    }
    throw err;
  }

  if (!res.ok) {
    const stale = reviewsCache.getStale();
    if (stale) {
      console.warn('[reviews] fetch failed, falling back to cache', res.message);
      return new Map(Object.entries(stale));
    }
    throw new Error(res.message);
  }

  if (!res.data.available) {
    const stale = reviewsCache.getStale();
    if (stale) return new Map(Object.entries(stale));
    throw new Error('NO_TOKEN: GITHUB_TOKEN 未在 main 配置');
  }

  const reviews: Review[] = [];
  for (const node of res.data.nodes) {
    const parsed = parseReview(node);
    if (parsed) reviews.push(parsed);
  }
  const byPid = aggregate(reviews);
  reviewsCache.set(Object.fromEntries(byPid));
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
  reviewsCache.reset();
}
