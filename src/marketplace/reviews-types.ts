// 插件评分 / 评论类型(doc/15 Phase 1)。
//
// review 数据存 GitHub Discussions(philip1974/continuo-plugins),
// reviews-fetcher.ts 走 GraphQL 拉 + parse → 这里的形态。

import { isHttpUrl } from './url-safety'; // 边界(E109):review url/avatarUrl scheme 白名单(共享)
import { isValidPluginId } from '../plugins/plugin-id'; // 边界(E113/E123):plugin id 形态契约(共享单一来源)

export interface Review {
  /** 从 discussion title 第一对方括号 / body 表单字段抽出的 plugin id. */
  readonly pluginId: string;
  readonly rating: 1 | 2 | 3 | 4 | 5;
  /** 评论正文(剥掉 schema 段头,只留 review section). */
  readonly body: string;
  readonly author: {
    readonly handle: string;
    readonly avatarUrl: string;
    /** Phase 3:author GitHub 账号注册时间(ISO),"新账号"角标用. */
    readonly createdAt: string;
  };
  /** 永久链接,点 → 跳 GitHub. */
  readonly url: string;
  readonly createdAt: string; // ISO
  /** Phase 3:THUMBS_UP reaction 总数,排序"最有用"用. */
  readonly thumbsUp: number;
  /** 可选:Continuo / plugin 版本. */
  readonly continuoVersion?: string;
  readonly pluginVersion?: string;
}

export interface PluginAggregateRating {
  readonly pluginId: string;
  readonly count: number;
  /** 算术平均(无加权). */
  readonly avg: number;
  /** 倒序按 createdAt(最新在前),最多 N 条(默认全收,UI 自截). */
  readonly reviews: readonly Review[];
}

// 边界(E3):reviews sessionStorage 缓存的 validate 此前只校验「是对象」就强转 Record<id,
// PluginAggregateRating>。畸形/旧格式缓存(如 {p:{count:1,avg:"bad",reviews:{}}})会被当新鲜或
// stale fallback 返回,Marketplace 渲染时 `rating.avg.toFixed()` / `rating.reviews.length` 直接崩
// 面板。深度类型守卫:逐 aggregate 校验 pluginId/count/avg 形态 + reviews 数组 + 每条 review 字段;
// 非法缓存当 cache miss(validate 返 false → 重拉)。
// 边界(E111,E57 写端逐字段截断的读端对偶):reviews sessionStorage 缓存的深度校验此前只校验
// 类型 / rating 值域 / URL scheme(E109)/ count===length,但**不校验字段长度与数量**。被篡改的
// 缓存只要整体 < raw cap(16MiB)就能塞入超长 body/handle/url、超多 reviews 或超多 aggregate key
// 通过 isValidAggregateRecord,Marketplace 打开后直接渲染到 DOM → 面板卡顿/冻结。镜像 main
// marketplace-reviews.service.ts(E57)的 clampStr 上限 + MAX_TOTAL_NODES,超限当 cache miss
// (validate 返 false → 重拉,main 侧再 clamp)。renderer 不可 import electron/main,故本地镜像常量。
const REVIEW_BODY_MAX = 16384; // 对齐 main REVIEW_BODY_MAX
// E294:导出供 fresh-parse(reviews-parser.parseReview)复用同值 —— 此前 fresh 路径只 isHttpUrl 不限长,
// 与 cache-read isValidReview(isStrMax REVIEW_URL_MAX)不对偶,超长合法 scheme URL 可绕 fresh 入 cache/DOM。
export const REVIEW_URL_MAX = 2048; // 对齐 main REVIEW_URL_MAX(url / avatarUrl)
const REVIEW_FIELD_MAX = 512; // 对齐 main REVIEW_FIELD_MAX(handle / createdAt)
const REVIEW_ID_MAX = 256; // pluginId(与 MP_ID_MAX 同量级)
const REVIEW_VERSION_MAX = 128; // continuoVersion / pluginVersion(与 manifest VERSION_MAX 对齐)
const MAX_REVIEWS_PER_PLUGIN = 2000; // 对齐 main MAX_TOTAL_NODES(单插件 reviews 上限)
const MAX_AGGREGATE_KEYS = 2000; // aggregate record 总 plugin 数上限(distinct plugin ≤ 总 node)
// 边界(E210):全局累计 reviews 数上限(对齐 main marketplace-reviews.service MAX_TOTAL_NODES)。
// 此前只限 key 数(MAX_AGGREGATE_KEYS)+ 单插件 reviews 数(MAX_REVIEWS_PER_PLUGIN),二者相乘最坏 400 万
// reviews —— 篡改 sessionStorage 可造很多 plugin × 各少量 reviews,总数远超 main 累计节点上限,打开
// Marketplace 时放大校验/Map 构建/渲染。累加每个 aggregate 的 reviews.length,超此上限即 cache miss。
const MAX_TOTAL_REVIEWS = 2000;

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

// 边界(E111):字符串非空(或可空)且长度 ≤ max。
const isStrMax = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max;

// 边界(E112):author.handle 被 MarketplaceTab 直接拼成 https://github.com/${handle} 个人主页链接,
// 且 maintainer/new-account 判断基于同一值。只校验 string 会让畸形 GraphQL/篡改缓存放入 ../user、
// a/b、x?tab=repositories 等非 GitHub login → 渲染指向错误账号/路径的可点击链接 + 错误徽章。
// 按 GitHub login 规则校验:1–39 字符,仅字母数字与单个中横线,首尾非 -、无连续 --(收敛后即
// URL/路径安全)。fresh-fetch(parseReview)与 cache-read(isValidReview)两端共用此校验。
const GITHUB_LOGIN_RE = /^[a-zA-Z0-9](?:-?[a-zA-Z0-9])*$/;
export function isGitHubLogin(s: string): boolean {
  return s.length >= 1 && s.length <= 39 && GITHUB_LOGIN_RE.test(s);
}

// 边界(E93):thumbsUp 须非负安全整数(点赞数不可为负/小数);与 main toNode canonicalize 对齐。
const isNonNegSafeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function isValidReview(v: unknown): v is Review {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  // 边界(E111 长度 + E113 形态):pluginId 是 aggregate byPid key + 与 entry.id 对账,须合法形态。
  if (!isStrMax(r.pluginId, REVIEW_ID_MAX) || !isValidPluginId(r.pluginId))
    return false;
  // 边界(E94):rating 须 1..5 整数(parseRating 的值域)。只校验 finite 会让篡改/旧缓存的
  // 999.0 / -1 / 2.5 stars 当新鲜数据渲染(aria-label="999 stars" 等畸形展示)。
  if (
    typeof r.rating !== 'number' ||
    !Number.isInteger(r.rating) ||
    r.rating < 1 ||
    r.rating > 5
  ) {
    return false;
  }
  // 边界(E111):body 长度上限(对齐 main REVIEW_BODY_MAX,防超长正文渲染放大)。
  if (!isStrMax(r.body, REVIEW_BODY_MAX)) return false;
  // 边界(E109,E108 同族):review.url 渲染为 <a href target="_blank">,须 http/https scheme
  //(拒 javascript:/file: 等);篡改缓存/畸形 GraphQL 不应让危险外链进 DOM。
  // 边界(E111):URL 长度上限(对齐 main REVIEW_URL_MAX)。
  if (!isStrMax(r.url, REVIEW_URL_MAX) || !isHttpUrl(r.url)) return false;
  if (!isStrMax(r.createdAt, REVIEW_FIELD_MAX)) return false; // 边界(E111)
  if (!isNonNegSafeInt(r.thumbsUp)) return false; // 边界(E93):非负安全整数,脏缓存当 miss
  if (typeof r.author !== 'object' || r.author === null) return false;
  const a = r.author as Record<string, unknown>;
  // 边界(E111 长度 + E112 GitHub login 形态):handle 拼进 github.com 个人主页 + maintainer 判断。
  if (!isStrMax(a.handle, REVIEW_FIELD_MAX) || !isGitHubLogin(a.handle)) return false;
  // 边界(E109):avatarUrl 渲染为 <img src>,同样限 http/https(拒 file:/data: 等)。
  // 边界(E111):URL 长度上限(对齐 main REVIEW_URL_MAX)。
  if (!isStrMax(a.avatarUrl, REVIEW_URL_MAX) || !isHttpUrl(a.avatarUrl))
    return false;
  if (!isStrMax(a.createdAt, REVIEW_FIELD_MAX)) return false; // 边界(E111)
  // 边界(E111):版本字段长度上限(对齐 manifest VERSION_MAX)。
  if (r.continuoVersion !== undefined && !isStrMax(r.continuoVersion, REVIEW_VERSION_MAX))
    return false;
  if (r.pluginVersion !== undefined && !isStrMax(r.pluginVersion, REVIEW_VERSION_MAX))
    return false;
  return true;
}

function isValidAggregate(v: unknown): v is PluginAggregateRating {
  if (typeof v !== 'object' || v === null) return false;
  const g = v as Record<string, unknown>;
  // 边界(E113):aggregate.pluginId 须合法形态(byPid key + 与 entry.id 对账)。
  if (typeof g.pluginId !== 'string' || !isValidPluginId(g.pluginId)) return false;
  // 边界(E94):count 须非负安全整数,avg 须 finite 且 1..5(评分均值值域)。只校验 finite
  // 会让负评价数 / 999.0 stars 渲染 + 污染排序。
  if (!isNonNegSafeInt(g.count)) return false;
  if (!isFiniteNumber(g.avg) || g.avg < 1 || g.avg > 5) return false;
  if (!Array.isArray(g.reviews)) return false; // reviews.length / map 须数组
  // 边界(E111):单插件 reviews 数量上限(对齐 main MAX_TOTAL_NODES),防超多 review 渲染放大。
  if (g.reviews.length > MAX_REVIEWS_PER_PLUGIN) return false;
  // 边界(E94):count 须与 reviews.length 一致(aggregate 构造时 count=rs.length;不一致=篡改)。
  if (g.count !== g.reviews.length) return false;
  if (!g.reviews.every(isValidReview)) return false;
  // 边界(E113):aggregate 构造时每条 review 按 pluginId 分组(key=pluginId=aggregate.pluginId=
  // 每条 review.pluginId)。篡改缓存可让三者不一致 → 评分错配到别的插件。强制每条 review.pluginId
  // 与 aggregate.pluginId 一致(key 与 aggregate.pluginId 的一致性在 isValidAggregateRecord 校验)。
  return (g.reviews as readonly Review[]).every((r) => r.pluginId === g.pluginId);
}

/** 边界(E3):reviews 缓存深度校验 —— 是非数组对象且每个 value 是合法 aggregate。 */
export function isValidAggregateRecord(
  d: unknown,
): d is Record<string, PluginAggregateRating> {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  const rec = d as Record<string, unknown>;
  // 边界(E197,E176/E189/E192 有界迭代族):单次 for...in 惰性遍历,边计数边校验 —— 不先
  // Object.keys/Object.entries 把篡改缓存的所有 key 全量物化(两次)再判上限。篡改 sessionStorage 可在
  // 16MiB raw cap 内塞海量短 key,旧实现 Marketplace 打开时先物化全部 key → renderer 内存/CPU 峰值。
  let count = 0;
  let totalReviews = 0;
  for (const key in rec) {
    if (!Object.prototype.hasOwnProperty.call(rec, key)) continue;
    // 边界(E111):aggregate record 总 plugin 数上限。超过立即 false,绝不继续遍历/物化。
    count += 1;
    if (count > MAX_AGGREGATE_KEYS) return false;
    const agg = rec[key];
    if (!isValidAggregate(agg)) return false;
    // 边界(E210):累加全局 reviews 数,超 MAX_TOTAL_REVIEWS(对齐 main MAX_TOTAL_NODES)立即 false ——
    // 挡"很多 plugin × 各少量 reviews"绕过单插件上限的累计放大。agg 已过 isValidAggregate(reviews 是数组)。
    totalReviews += agg.reviews.length;
    if (totalReviews > MAX_TOTAL_REVIEWS) return false;
    // 边界(E113):record key 须与对应 aggregate.pluginId 一致(aggregate 构造时 key=pluginId)。
    // 篡改缓存可让 byPid 的 key 与 aggregate.pluginId 不符 → 评分错配到别的插件。
    if ((agg as PluginAggregateRating).pluginId !== key) return false;
  }
  return true;
}
