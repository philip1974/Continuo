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
//
// 本文件**不 import zod** —— preload(sandbox,无 zod)会 import MARKETPLACE_CHANNELS 值,
// 若混入 zod schema 会把 zod 拖进 preload 产物致 `require('zod')` 加载失败。zod 入参
// schema(仅 main 用)放在 ipc/marketplace.ipc.ts。(修复 S4 引入的 preload zod 泄漏)

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
