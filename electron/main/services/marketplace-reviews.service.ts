// 安全 S4:marketplace reviews 拉取移到 main 进程。token 走运行时 GITHUB_TOKEN env,
// 绝不内联进 renderer 产物;只跑固定查询,renderer 接触不到 token。
//
// 无 GITHUB_TOKEN(prod GUI 启动常态)→ available:false,renderer 降级到 cache。

import type {
  FetchReviewsResult,
  MarketplaceReviewNode,
} from '../../shared/marketplace-channels';
import { capJoinedMessagesFrom } from '../lib/format-zod-error';
import { readResponseTextCapped } from '../../shared/read-capped';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const OWNER = 'philip1974';
const NAME = 'continuo-plugins';
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // safety bound,对齐旧 renderer 实现

// 边界(E57,E2/E3 外部网络输入族):GitHub GraphQL reviews 响应是外部仓库数据(discussion body
// 由任意 plugin 作者填写,可很大)。此前 await r.json() 无响应体上限,最多 50×100=5000 nodes 原样
// 返回,title/body/url/author 无长度校验;renderer 还对每条 body.split → 在 main JSON 解析、IPC
// 传输、renderer split/aggregate/sessionStorage 缓存多次放大致卡顿/OOM。逐字段截断 + 节点总数上限
// + 响应体 Content-Length 预检(best-effort)。
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 单页响应体上限(Content-Length 预检)
const REVIEW_TITLE_MAX = 1024;
const REVIEW_BODY_MAX = 16384;
const REVIEW_URL_MAX = 2048;
const REVIEW_FIELD_MAX = 512; // author.login/avatarUrl/createdAt 等
const MAX_TOTAL_NODES = 2000; // 累计节点上限(远超任何现实 review 量)
// 边界(E298):GraphQL pageInfo.endCursor 长度上限。cursor 是不透明短分页 token(GitHub 实际 ~数十字符),
// 回传进下一页请求 body 的 `after` 变量。无上限则畸形/被篡改响应可塞超大 cursor 撑大出站请求。cursor
// 不能截断(会损坏分页),超此上限即停止翻页(已收到的页仍可用)。2048 远超任何真实 cursor。
const MAX_CURSOR_LEN = 2048;

function clampStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

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
  // 边界(E57):逐字段截断 + 类型守卫,bound IPC payload + 下游 split/aggregate/缓存放大。
  // 边界(E93):thumbsUp 须非负安全整数 —— 只校验 finite 会让畸形 GraphQL 把点赞数设成负数/
  // 小数(👍-3 / 👍1.5),污染显示 + "Helpful" 排序 + 缓存。canonicalize 为非负安全整数,否则 0。
  const rawThumbs = n.reactions?.totalCount;
  const thumbsUp =
    typeof rawThumbs === 'number' &&
    Number.isSafeInteger(rawThumbs) &&
    rawThumbs >= 0
      ? rawThumbs
      : 0;
  return {
    title: clampStr(n.title, REVIEW_TITLE_MAX),
    body: clampStr(n.body, REVIEW_BODY_MAX),
    url: clampStr(n.url, REVIEW_URL_MAX),
    createdAt: clampStr(n.createdAt, REVIEW_FIELD_MAX),
    author: n.author
      ? {
          login: clampStr(n.author.login, REVIEW_FIELD_MAX),
          avatarUrl: clampStr(n.author.avatarUrl, REVIEW_URL_MAX),
          ...(n.author.createdAt !== undefined
            ? { createdAt: clampStr(n.author.createdAt, REVIEW_FIELD_MAX) }
            : {}),
        }
      : null,
    thumbsUp,
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
    // 边界(E57+E65+E124):响应体上限。Content-Length 仅 best-effort 预检(可缺省/伪造/chunked
    // 时为 0 放行),不能作权威闸。E124:改用流式按**真实字节**累计硬截断(旧 `await r.text()` 在
    // 检查前就把整个 body 读入内存,且 text.length 是 char 数非字节 → 多字节 UTF-8 绕过上限),
    // 超限抛 MARKETPLACE_RESPONSE_TOO_LARGE,再 JSON.parse(与 fetcher.ts readJsonCapped 共用 helper)。
    const text = await readResponseTextCapped(
      r,
      MAX_RESPONSE_BYTES,
      () => new Error('MARKETPLACE_RESPONSE_TOO_LARGE'),
    );
    // 边界(E166,E165 兄弟/顶层形态):JSON.parse 结果直接当 GraphqlResp 用,但合法 JSON 顶层可为
    // null / 字符串 / 数组 / 数字 —— `json.errors`(尤其 `null.errors`)在属性访问处抛 TypeError →
    // 拉取走异常降级而非可控 code。parse 后先校验顶层是非 null 非数组对象,否则抛稳定错误。
    const parsedTop: unknown = JSON.parse(text);
    if (
      parsedTop === null ||
      typeof parsedTop !== 'object' ||
      Array.isArray(parsedTop)
    ) {
      throw new Error('MARKETPLACE_RESPONSE_INVALID');
    }
    const json = parsedTop as GraphqlResp;
    // 边界(E165,E106 外部形态校验族):json.errors 来自外部 GraphQL 响应,TS 类型不构成运行时保证。
    // 此前 `json.errors && json.errors.length > 0` 后直接 `.map(...)` —— 畸形响应给 `{errors:{length:1}}`
    // 或 `{errors:"x"}`(truthy 且 length>0,但非数组)会在 .map 处抛 TypeError → 整次 reviews 拉取失败
    // 退 stale/error,而非安全规范化。先 Array.isArray 守卫:非数组 errors 视为无结构化错误跳过(若同时
    // 无有效 data,下方 `!d || !Array.isArray(d.nodes)` 兜底 break)。
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      // 边界(E75,E73 错误串放大族):GraphQL errors 来自外部响应,数组条数/单条 message 长度
      // 都不可控(8MiB 内可塞大量错误)。经 capJoinedMessages 限条数 + 总长,防超长错误串经
      // safeHandle/renderer 错误状态/通知链路放大。message 强制 String 化(外部数据可能非 string)。
      // 边界(E222):用 mapper 变体,只对前 N 条 errors 调 String(...),不先 json.errors.map(...) 把
      // 外部可控数量的 errors(8MiB 内可塞大量短 errors)全量物化成 string 数组再 cap。
      const msg = capJoinedMessagesFrom(json.errors, (e) => String(e?.message ?? ''));
      throw new Error(`GraphQL: ${msg}`);
    }
    const d = json.data?.repository?.discussions;
    if (!d || !Array.isArray(d.nodes)) break;
    for (const node of d.nodes) {
      if (out.length >= MAX_TOTAL_NODES) break; // 边界(E57):累计节点上限
      // 边界(E106):外部 GraphQL node 可能 null/非对象;toNode 直接读 n.reactions/n.title 会抛 →
      // 单个坏节点让整次 reviews 拉取失败、Marketplace 评分整体退回 stale/error。逐节点校验对象
      // 形态,坏节点跳过(其余 review 仍可用)。toNode 内部对各字段已有 typeof 守卫,非空对象即安全。
      if (node === null || typeof node !== 'object') continue;
      out.push(toNode(node));
    }
    if (out.length >= MAX_TOTAL_NODES) break; // 满则停止翻页
    // 边界(E106):pageInfo 也来自外部响应,可能缺/非对象;先判形态再读 hasNextPage/endCursor
    //(否则畸形响应在 d.pageInfo.hasNextPage 处抛)。无有效 string 游标 → 停止翻页。
    const pageInfo: unknown = d.pageInfo;
    if (
      pageInfo === null ||
      typeof pageInfo !== 'object' ||
      (pageInfo as { hasNextPage?: unknown }).hasNextPage !== true
    ) {
      break;
    }
    const endCursor = (pageInfo as { endCursor?: unknown }).endCursor;
    // 边界(E298):endCursor 回传进下一页请求 body(after)。非 string 或超 MAX_CURSOR_LEN(畸形/被篡改
    // 响应塞超大 cursor)→ 停止翻页(cursor 不透明不能截断,否则损坏分页;已收到页仍可用)。
    if (typeof endCursor !== 'string' || endCursor.length > MAX_CURSOR_LEN) break;
    after = endCursor;
  }
  return { available: true, nodes: out };
}
