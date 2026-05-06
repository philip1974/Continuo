// 评论拉取(doc/15 Phase 1)。
//
// GitHub GraphQL API 必须 auth(unauth 返 403)。VITE_GITHUB_TOKEN 环境变量
// 注入只读 public_repo PAT;缺则 fetcher 不发请求,store 直接返空。
//
// 缓存:1h sessionStorage 同 marketplace index 模式。

import { getCachedFetch } from '../plugins/sandbox-sweep';
import { parseReview } from './reviews-parser';
import type { PluginAggregateRating, Review } from './reviews-types';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_KEY = 'continuo:marketplace:reviews';
const PAGE_SIZE = 100;

interface CachedReviews {
  readonly fetchedAt: number;
  readonly byPid: Record<string, PluginAggregateRating>;
}

let memoryCache: CachedReviews | null = null;

const QUERY = `
query Reviews($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: $first, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        title body url createdAt
        author {
          login avatarUrl
          ... on User { createdAt }
        }
        reactions(content: THUMBS_UP) { totalCount }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`.trim();

interface GraphqlNode {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly author: {
    readonly login: string;
    readonly avatarUrl: string;
    readonly createdAt?: string;
  } | null;
  readonly reactions: { readonly totalCount: number };
}

interface GraphqlResp {
  readonly data?: {
    readonly repository?: {
      readonly discussions?: {
        readonly nodes: readonly GraphqlNode[];
        readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
      };
    };
  };
  readonly errors?: readonly { readonly message: string }[];
}

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

function getToken(): string | null {
  // Vite renderer 暴露的 env;dev 走 .env.local,prod 走打包时注入
  const t = (import.meta.env.VITE_GITHUB_TOKEN as string | undefined) ?? '';
  return t.length > 0 ? t : null;
}

/**
 * 拉所有 reviews,按 plugin id 聚合。
 *
 * - 无 token / cache 新鲜 → 走 cache(无 token 也至少返之前缓存的)
 * - 网络失败 → 退守 cache;无 cache 抛
 * - forceRefresh → 跳 cache 强拉(token 必须有,否则抛 NO_TOKEN)
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

  const token = getToken();
  if (!token) {
    if (memoryCache) return new Map(Object.entries(memoryCache.byPid));
    throw new Error('NO_TOKEN: VITE_GITHUB_TOKEN 未配置');
  }

  try {
    const reviews = await fetchAllPages(token);
    const byPid = aggregate(reviews);
    const next: CachedReviews = {
      fetchedAt: Date.now(),
      byPid: Object.fromEntries(byPid),
    };
    memoryCache = next;
    writeSessionCache(next);
    return byPid;
  } catch (err) {
    if (memoryCache) {
      console.warn('[reviews] fetch failed, falling back to cache', err);
      return new Map(Object.entries(memoryCache.byPid));
    }
    throw err;
  }
}

async function fetchAllPages(token: string): Promise<readonly Review[]> {
  const out: Review[] = [];
  let after: string | null = null;
  let safety = 0;
  while (safety++ < 50) {
    const r = await getCachedFetch()(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
      },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          owner: 'philip1974',
          name: 'continuo-plugins',
          first: PAGE_SIZE,
          after,
        },
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = (await r.json()) as GraphqlResp;
    if (json.errors && json.errors.length > 0) {
      throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    const d = json.data?.repository?.discussions;
    if (!d) break;
    for (const node of d.nodes) {
      const parsed = parseReview({
        title: node.title,
        body: node.body,
        url: node.url,
        createdAt: node.createdAt,
        author: node.author,
        thumbsUp: node.reactions.totalCount,
      });
      if (parsed) out.push(parsed);
    }
    if (!d.pageInfo.hasNextPage) break;
    after = d.pageInfo.endCursor;
  }
  return out;
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
