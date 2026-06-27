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
import {
  isValidAggregateRecord,
  type PluginAggregateRating,
  type Review,
} from './reviews-types';
import { createSessionCache } from './session-cache';

// 边界(E243):renderer 侧 review nodes 数量上限(对齐 main marketplace-reviews.service MAX_TOTAL_NODES=2000)。
// 读端独立截断,防畸形/超大 IPC payload 绕过 main 上限。导出供测试。
export const MAX_REVIEW_NODES = 2000;

// 可维护性 M19:1h sessionStorage 缓存样板复用 createSessionCache(与 index fetcher 共用)。
// 缓存的是聚合后的 byPid(plugin id → PluginAggregateRating)Record。
const reviewsCache = createSessionCache<
  Record<string, PluginAggregateRating>
>({
  key: 'continuo:marketplace:reviews',
  ttlMs: 60 * 60 * 1000,
  // 边界(E3):深度校验每个 aggregate(avg/count 有限数值、reviews 数组+字段),非法当 cache miss。
  validate: isValidAggregateRecord,
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
    if (fresh) return aggregateRecordToMap(fresh);
  }

  let res: Awaited<ReturnType<typeof coApi.marketplace.fetchReviews>>;
  try {
    res = await coApi.marketplace.fetchReviews();
  } catch (err) {
    const stale = reviewsCache.getStale();
    if (stale) {
      console.warn('[reviews] IPC failed, falling back to cache', err);
      return aggregateRecordToMap(stale);
    }
    throw err;
  }

  if (!res.ok) {
    const stale = reviewsCache.getStale();
    if (stale) {
      console.warn('[reviews] fetch failed, falling back to cache', res.message);
      return aggregateRecordToMap(stale);
    }
    throw new Error(res.message);
  }

  if (!res.data.available) {
    const stale = reviewsCache.getStale();
    if (stale) return aggregateRecordToMap(stale);
    // i18n(I12,I5 同族):抛稳定 code(非中文 prose),UI 按 errors.<CODE> catalog 本地化
    // (en/ko 不泄漏中文)。网络等动态错误仍走原 message(无 catalog 回退)。
    throw new Error('MARKETPLACE_REVIEWS_NO_TOKEN');
  }

  // 边界(E243,E215 读端独立校验族):res.data.nodes 来自 IPC,renderer 不应只信 main 侧约束 ——
  // 畸形 payload(非数组)会让 for...of 抛;超大数组(畸形/未来 main 回归)绕过 renderer 侧上限放大
  // parse/aggregate/渲染。读端独立守卫:非数组当无 reviews(回退 stale 或空,稳定不抛),数组按
  // MAX_REVIEW_NODES(对齐 main MAX_TOTAL_NODES=2000)截断。
  const rawNodes: unknown = res.data.nodes;
  if (!Array.isArray(rawNodes)) {
    const stale = reviewsCache.getStale();
    if (stale) return aggregateRecordToMap(stale);
    return new Map();
  }
  const nodeCount = Math.min(rawNodes.length, MAX_REVIEW_NODES);
  const reviews = new Array<Review>(nodeCount);
  let reviewCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    const parsed = parseReview(rawNodes[i]);
    if (parsed) {
      reviews[reviewCount] = parsed;
      reviewCount += 1;
    }
  }
  reviews.length = reviewCount;
  const byPid = aggregate(reviews);
  reviewsCache.set(aggregateMapToRecord(byPid));
  return byPid;
}

function aggregateRecordToMap(
  record: Record<string, PluginAggregateRating>,
): Map<string, PluginAggregateRating> {
  const out = new Map<string, PluginAggregateRating>();
  for (const pluginId in record) {
    if (Object.prototype.hasOwnProperty.call(record, pluginId)) {
      out.set(pluginId, record[pluginId]!);
    }
  }
  return out;
}

function aggregateMapToRecord(
  map: ReadonlyMap<string, PluginAggregateRating>,
): Record<string, PluginAggregateRating> {
  const record: Record<string, PluginAggregateRating> = {};
  for (const [pluginId, aggregateRating] of map) {
    record[pluginId] = aggregateRating;
  }
  return record;
}

function aggregate(
  reviews: readonly Review[],
): Map<string, PluginAggregateRating> {
  const groups = new Map<
    string,
    { reviews: Review[] | null; sum: number; count: number; writeIndex: number }
  >();
  for (const r of reviews) {
    let group = groups.get(r.pluginId);
    if (!group) {
      group = { reviews: null, sum: 0, count: 0, writeIndex: 0 };
      groups.set(r.pluginId, group);
    }
    group.sum += r.rating;
    group.count += 1;
  }
  for (const group of groups.values()) {
    group.reviews = new Array<Review>(group.count);
  }
  for (const r of reviews) {
    const group = groups.get(r.pluginId)!;
    group.reviews![group.writeIndex] = r;
    group.writeIndex += 1;
  }
  const out = new Map<string, PluginAggregateRating>();
  for (const [pluginId, group] of groups) {
    out.set(pluginId, {
      pluginId,
      count: group.count,
      avg: group.sum / group.count,
      reviews: group.reviews!, // 已按 createdAt DESC(GraphQL orderBy)
    });
  }
  return out;
}

/** 测试用:重置 cache. */
export function _resetReviewsCacheForTest(): void {
  reviewsCache.reset();
}
