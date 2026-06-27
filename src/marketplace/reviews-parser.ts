// review discussion body / title 解析(纯函数,易测)。
//
// GitHub discussion form template 提交后,body 形如:
//   ### Plugin ID
//   com.example.foo
//   ### 评分
//   ★★★★★ 5
//   ### 评论正文
//   多行文字...
//   ### Continuo 版本(可选)
//   0.1.0
//
// 我们 split by "### " 收 sections,容错(用户自己写也兼容简单形态)。

import type { Review } from './reviews-types';
import { isGitHubLogin, REVIEW_URL_MAX } from './reviews-types';
import { isValidPluginId } from '../plugins/plugin-id'; // 边界(E113/E123):共享单一来源
import { isHttpUrl } from './url-safety'; // 边界(E143,E109 fresh-fetch 对偶):url/avatarUrl scheme 白名单

interface RawDiscussion {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly author: {
    readonly login: string;
    readonly avatarUrl: string;
    /** Phase 3:GraphQL `User { createdAt }`. 缺时给 epoch 0(被标新账号). */
    readonly createdAt?: string;
  } | null;
  /** Phase 3:THUMBS_UP reaction 总数,缺给 0. */
  readonly thumbsUp?: number;
}

// 边界(E57):renderer 防御性长度上限 —— 即便 main 已逐字段截断(E57),parseReview 也自带
// body/title 上限,挡绕过 main 的 cache-hydrate / 测试 / 未来入口(body.split / section 聚合会被
// 超长 body 放大)。值与 main REVIEW_BODY_MAX/REVIEW_TITLE_MAX 对齐。
const MAX_PARSE_BODY = 16384;
const MAX_PARSE_TITLE = 1024;
// 边界(E253):fresh 解析的字段长度上限,与 cache-read isValidReview 对齐(REVIEW_FIELD_MAX=512
// handle/createdAt;REVIEW_VERSION_MAX=128 版本)。fresh 路径此前对 createdAt/author.createdAt/版本
// 只 nullish 合并不校验类型/长度 → 畸形 IPC 可把 object/超长写进 Review,new Date() 变 Invalid/NaN 漏标。
const REVIEW_FIELD_MAX = 512;
const REVIEW_VERSION_MAX = 128;

/** 失败返 null(skip 这条 review,不污染聚合). */
export function parseReview(rawInput: unknown): Review | null {
  // 边界(E250,E243 续 / fresh-fetch 与 cache-read 校验对偶):fetchAllReviews 只校验 nodes 是数组,
  // 元素仍可为 null/数字/字符串。此前入参类型 RawDiscussion 假设已是对象,raw.body 对 null 元素抛
  // TypeError → 单个畸形节点让整个 reviews 加载失败(绕过"非数组回退/空 Map"+ 后续字段级校验)。
  // 入参收为 unknown,先校验非 null 对象再取字段(坏节点跳过不抛),与 cache-read isValidReview 对齐。
  if (typeof rawInput !== 'object' || rawInput === null) return null;
  const raw = rawInput as RawDiscussion;
  if (typeof raw.body !== 'string' || typeof raw.title !== 'string') return null;
  // 边界(E250/E253):createdAt 渲染/排序用,fresh 路径补 string + 长度校验(与 cache-read 对齐)。
  if (typeof raw.createdAt !== 'string' || raw.createdAt.length > REVIEW_FIELD_MAX)
    return null;
  // 边界(E57):split / extract 前先截断,防超长 body/title 在解析处放大。
  const safeBody =
    raw.body.length > MAX_PARSE_BODY ? raw.body.slice(0, MAX_PARSE_BODY) : raw.body;
  const safeTitle =
    raw.title.length > MAX_PARSE_TITLE
      ? raw.title.slice(0, MAX_PARSE_TITLE)
      : raw.title;
  const sections = parseSections(safeBody);

  // pluginId:优先 body section,fallback title 第一对方括号
  const pluginId =
    sections.get('plugin id')?.trim() ?? extractPluginIdFromTitle(safeTitle);
  // 边界(E113):body section 路径此前只 trim() 不校验形态(title fallback 正则反而有
  // [a-z0-9._-]+ 约束,不对称)。pluginId 被用作 aggregate byPid key + 与 entry.id 对账,
  // 畸形值(空格 / / .. / 超长)会污染聚合/缓存。两条路径统一复用共享 isValidPluginId。
  if (!pluginId || !isValidPluginId(pluginId)) return null;

  const ratingRaw = sections.get('评分') ?? sections.get('rating');
  const rating = parseRating(ratingRaw);
  if (rating === null) return null;

  const body =
    sections.get('评论正文')?.trim() ??
    sections.get('review')?.trim() ??
    safeBody.trim();
  if (body.length === 0) return null;

  if (!raw.author) return null;
  // 边界(E112):handle 拼进 github.com 个人主页链接 + maintainer 判断;非 GitHub login 形态
  //(../user、a/b、x?tab=...)跳过该 review(与 cache-read isValidReview 同款校验)。
  if (typeof raw.author.login !== 'string' || !isGitHubLogin(raw.author.login))
    return null;
  // 边界(E143,E109 fresh-fetch 对偶):review.url 渲染为 <a href>、avatarUrl 渲染为 <img src>,
  // 须 http/https(拒 javascript:/file: 等)。cache-read(isValidReview,E109)已校验,但 fresh GraphQL
  // 解析路径此前原样写入 → 首次拉取可绕过白名单渲染危险外链/src(同 E112 双进 DOM 路径教训)。
  // 边界(E294,E253/E250 fresh↔cache-read 长度对偶):cache-read 用 isStrMax(url, REVIEW_URL_MAX) 限长,
  // 但 fresh 此前只 isHttpUrl 不限长 → 合法 scheme 的超长 URL(https://+巨串)首拉绕过,进 review cache/UI
  // /new URL() 放大。补 REVIEW_URL_MAX 长度上限(与 cache-read 同值同源)。
  if (
    typeof raw.url !== 'string' ||
    raw.url.length > REVIEW_URL_MAX ||
    !isHttpUrl(raw.url) ||
    typeof raw.author.avatarUrl !== 'string' ||
    raw.author.avatarUrl.length > REVIEW_URL_MAX ||
    !isHttpUrl(raw.author.avatarUrl)
  )
    return null;

  return {
    pluginId,
    rating,
    body,
    author: {
      handle: raw.author.login,
      avatarUrl: raw.author.avatarUrl,
      // 边界(E253):author.createdAt 仅当 string 且 ≤REVIEW_FIELD_MAX 才采用,否则默认 epoch(与
      // cache-read isValidReview 对齐)。此前 `?? epoch` 只挡 nullish,object/超长字符串会写进 Review →
      // 新账号风险判断 new Date(...) 变 Invalid Date/NaN 漏标。
      createdAt:
        typeof raw.author.createdAt === 'string' &&
        raw.author.createdAt.length <= REVIEW_FIELD_MAX
          ? raw.author.createdAt
          : '1970-01-01T00:00:00Z',
    },
    // 边界(E144,E93 fresh-fetch 对偶):thumbsUp 须非负安全整数 —— 防负数/小数/超安全整数/非数
    // 进入 helpful 排序(b.thumbsUp - a.thumbsUp 出现 NaN/错序)。生产 fresh 路径经 main toNode(E93)
    // 已 canonicalize,此为 parseReview 自守(与 cache-read isValidReview / 导出函数对偶,defense-in-depth)。
    thumbsUp:
      typeof raw.thumbsUp === 'number' &&
      Number.isSafeInteger(raw.thumbsUp) &&
      raw.thumbsUp >= 0
        ? raw.thumbsUp
        : 0,
    url: raw.url,
    createdAt: raw.createdAt,
    // 边界(E253):版本字段长度上限 REVIEW_VERSION_MAX(与 cache-read isValidReview 对齐),超长→undefined。
    continuoVersion: capVersion(sections.get('continuo 版本(可选)')?.trim()),
    pluginVersion: capVersion(sections.get('plugin 版本(可选)')?.trim()),
  };
}

/** 边界(E253):版本字段 trim 后 ≤REVIEW_VERSION_MAX 才采用,空/超长 → undefined。 */
function capVersion(v: string | undefined): string | undefined {
  if (v === undefined || v.length === 0 || v.length > REVIEW_VERSION_MAX) {
    return undefined;
  }
  return v;
}

/** "### Foo\nbar baz\n### Qux\n..." → Map { foo: "bar baz", qux: ... }(key 小写). */
function parseSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let curKey: string | null = null;
  let curBuf: string[] = [];
  const flush = () => {
    if (curKey) out.set(curKey, curBuf.join('\n').trim());
  };
  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) {
      flush();
      curKey = (m[1] ?? '').toLowerCase();
      curBuf = [];
    } else if (curKey) {
      curBuf.push(line);
    }
  }
  flush();
  return out;
}

function extractPluginIdFromTitle(title: string): string | null {
  const m = title.match(/^\s*\[([a-z0-9._-]+)\]/i);
  return m ? (m[1] ?? null) : null;
}

function parseRating(raw: string | undefined): Review['rating'] | null {
  if (!raw) return null;
  // "★★★★★ 5" / "★★★ 3" / "5" / "5/5" 都能解析
  const stars = (raw.match(/★/g) ?? []).length;
  if (stars >= 1 && stars <= 5) return stars as Review['rating'];
  const m = raw.match(/\b([1-5])\b/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 5) return n as Review['rating'];
  }
  return null;
}
