// 安全 S4:marketplace reviews 拉取移到 main 进程。token 走运行时 GITHUB_TOKEN env,
// 绝不内联进 renderer 产物;只跑固定查询,renderer 接触不到 token。
//
// 无 GITHUB_TOKEN(prod GUI 启动常态)→ available:false,renderer 降级到 cache。

import type {
  FetchReviewsResult,
  MarketplaceReviewNode,
} from '../../shared/marketplace-channels';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const OWNER = 'philip1974';
const NAME = 'continuo-plugins';
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // safety bound,对齐旧 renderer 实现

// 固定查询(硬编码在 main):renderer 不能注入任意 query 借 token 滥用。
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
        readonly pageInfo: {
          readonly hasNextPage: boolean;
          readonly endCursor: string | null;
        };
      };
    };
  };
  readonly errors?: readonly { readonly message: string }[];
}

function readToken(): string | null {
  const t = process.env['GITHUB_TOKEN'] ?? '';
  return t.length > 0 ? t : null;
}

function toNode(n: GraphqlNode): MarketplaceReviewNode {
  return {
    title: n.title,
    body: n.body,
    url: n.url,
    createdAt: n.createdAt,
    author: n.author,
    thumbsUp: n.reactions.totalCount,
  };
}

/**
 * 用运行时 GITHUB_TOKEN 拉全部 reviews discussions(分页),返回原始 nodes。
 * 无 token → available:false（renderer 降级 cache）。GraphQL/网络错误 → throw（safeHandle
 * 包成 IpcFail，renderer 退守 cache）。
 */
export async function fetchReviewNodes(): Promise<FetchReviewsResult> {
  const token = readToken();
  if (!token) return { available: false, nodes: [] };

  const out: MarketplaceReviewNode[] = [];
  let after: string | null = null;
  let pages = 0;
  while (pages++ < MAX_PAGES) {
    const r = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { owner: OWNER, name: NAME, first: PAGE_SIZE, after },
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = (await r.json()) as GraphqlResp;
    if (json.errors && json.errors.length > 0) {
      throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    const d = json.data?.repository?.discussions;
    if (!d) break;
    for (const node of d.nodes) out.push(toNode(node));
    if (!d.pageInfo.hasNextPage) break;
    after = d.pageInfo.endCursor;
  }
  return { available: true, nodes: out };
}
