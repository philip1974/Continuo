// 安全 S4(codex 安全审计):marketplace 评论拉取。
//
// 旧实现 renderer 直接用 `import.meta.env.VITE_GITHUB_TOKEN` 调 GitHub GraphQL —— Vite
// 会把 `VITE_*` 内联进 renderer 产物,任何 renderer 内插件 / 拿到打包应用的人都能提取
// 该 token(凭据泄漏 + 配额滥用)。桌面应用无法安全内嵌共享密钥。
//
// 修复:token 读取 + GitHub fetch 移到 main 进程(token 走运行时 `GITHUB_TOKEN` env,
// 绝不内联);main 只跑**固定**的 reviews 查询(owner/name/query 硬编码,不接受任意
// query,防 renderer 内插件借代理滥用 token),返回原始 discussion nodes;renderer 只拿
// nodes 做 parse/aggregate,接触不到 token。
import { z } from 'zod';

export const MARKETPLACE_CHANNELS = {
  /** main 用运行时 GITHUB_TOKEN 拉 philip1974/continuo-plugins 的 reviews discussions. */
  FETCH_REVIEWS: 'marketplace:fetch-reviews',
} as const;

/** 返回给 renderer 的单条 discussion node(已把 reactions.totalCount 拍平成 thumbsUp). */
export interface MarketplaceReviewNode {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly author: {
    readonly login: string;
    readonly avatarUrl: string;
    readonly createdAt?: string;
  } | null;
  readonly thumbsUp: number;
}

export interface FetchReviewsResult {
  /** false = main 无 GITHUB_TOKEN(prod GUI 启动常态)→ renderer 优雅降级到 cache. */
  readonly available: boolean;
  readonly nodes: readonly MarketplaceReviewNode[];
}

/** 无入参(查询参数全部由 main 固定),用 strict 空对象拒任何字段. */
export const fetchReviewsInputSchema = z.object({}).strict();
export type FetchReviewsInput = z.infer<typeof fetchReviewsInputSchema>;
