// 插件商店类型(Phase 1)。
// 与索引仓库 philip1974/continuo-plugins 的 index.json schema 对齐。
//
// version 不在此处:由各 plugin repo 的 manifest.json 当版本源。
// 索引只指方向,fetcher 取 manifest 拿真实 version。

import { isHttpUrl } from './url-safety'; // 边界(E108):authorUrl scheme 白名单(共享)
import { isValidPluginId } from '../plugins/plugin-id'; // 边界(E110/E113/E123):plugin id 形态契约(共享单一来源)

export interface MarketplaceEntry {
  /** 反 DNS 唯一 id,与 plugin manifest.id 一致. */
  readonly id: string;
  /** 显示名. */
  readonly name: string;
  /** 一句话简介. */
  readonly description?: string;
  /** 作者 handle. */
  readonly author: string;
  /** 作者主页. */
  readonly authorUrl?: string;
  /** GitHub `owner/name` 格式. */
  readonly repo: string;
  /** 默认 'main'. */
  readonly branch?: string;
  /** 自由字符串数组. */
  readonly tags?: readonly string[];
  /** 官方 review 过 → true,缺省 = 社区贡献. */
  readonly verified?: boolean;
}

// 边界(E2 + E25):index.json 来自远程仓库,顶层是数组就强转 MarketplaceEntry[] 时元素/字段形态
// 完全未校验。畸形 entry(null / 缺 repo / tags:{} / 字段类型错)会通过缓存,在 applyFilter() / 卡片
// 渲染 / 更新检查里触发 TypeError 崩面板,或 entryToGitUrl 拼出 https://github.com/undefined.git。
// E25 强化:不仅校验类型,还限制字段长度、tags 数量,并用正则约束 repo 为两段安全的 GitHub
// owner/name、branch 为 GitHub 安全字符 —— 否则远程可放超长字段/海量 tags 在过滤/排序/渲染/URL
// 拼接放大 CPU/内存,畸形 repo 还生成异常 raw/github URL。超限/非法 entry 被过滤掉(不缓存)。
const MP_ID_MAX = 256;
const MP_NAME_MAX = 256;
const MP_AUTHOR_MAX = 256;
const MP_DESC_MAX = 4096;
const MP_URL_MAX = 2048;
const MP_REPO_MAX = 512;
const MP_BRANCH_MAX = 256;
const MP_TAG_MAX = 128;
const MP_TAGS_COUNT_MAX = 64;
// 边界(E107,E104 同类 URL path-segment 漏洞):repo 须两段 owner/name,每段 [A-Za-z0-9._-] 且
// 非 '.'/'..'。旧 REPO_RE `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/` 字符集含 '.',放行 '../x'、'a/..'、
// './x' 等点段 → entryToGitUrl/ManifestUrl 直接拼 URL,WHATWG URL 把 /../x.git 归一化成 /x.git
// → repo 逃出预期两段路径,clone/manifest 指向错误仓库。段级校验拒点段(见 isValidRepo)。
// REPO_SEG_RE 与 branch 段同字符集。
// 边界(E110):entry.id 此前只校验非空 + 长度,未按文档契约(本文件顶部:"与 plugin manifest.id
// 一致")校验形态。畸形 index 可放含空格/&/#//、./.. 的 id。UI 用 entry.id 建安装/pending/
// reviews/update 状态索引(MarketplaceTab installed.has/pending.has/updateByPid.get/reviewsByPid.get),
// 而真实安装结果按 manifest.id 建索引 → id 不合契约时卡片状态长期错配;且 "See all" 链接把 entry.id
// 直接插值进 discussions_q=%5B${entry.id}%5D 查询(未 encode),畸形字符可破坏/注入该 query。
// 与 manifest ManifestSchema.id(/^[a-z0-9._-]+$/)+ isSafePluginId(拒 '.'/'..')同款契约:
// charset 收敛后 entry.id 即 URL/路径安全。非法 id 整条 entry 丢弃(不缓存)。
// E113:isValidPluginId 抽到共享 ./plugin-id(reviews 链路同款复用)。

const REPO_SEG_RE = /^[A-Za-z0-9._-]+$/;
function isValidRepo(r: string): boolean {
  const segs = r.split('/');
  if (segs.length !== 2) return false; // 必须正好 owner/name 两段
  return segs.every((s) => REPO_SEG_RE.test(s) && s !== '.' && s !== '..');
}


// 边界(E104):branch 按 Git refname/path-segment 级校验,而非旧 BRANCH_RE `/^[A-Za-z0-9._/-]+$/`
//(允许 ..、前导/尾随 /、连续 //)。entryToManifestUrl 把 branch 直接拼进 raw.githubusercontent.com
// 路径,旧正则放行 "../../other/repo/main" 会逃出 owner/repo/<branch>/manifest.json 结构 → 拉错
// manifest / 错误更新提示 / 安装元数据错位。逐段校验:非空、无前导/尾随 /、无连续 //、每段
// 仅 [A-Za-z0-9._-] 且非 '.'/'..'(charset 已排除控制字符且 URL-safe,无需额外 encode)。
const BRANCH_SEG_RE = /^[A-Za-z0-9._-]+$/;
function isValidBranch(b: string): boolean {
  if (b.length === 0 || b.length > MP_BRANCH_MAX) return false;
  if (b.startsWith('/') || b.endsWith('/') || b.includes('//')) return false;
  return b
    .split('/')
    .every((s) => BRANCH_SEG_RE.test(s) && s !== '.' && s !== '..');
}

export function isValidMarketplaceEntry(v: unknown): v is MarketplaceEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  // 边界(E110):id 须符合 plugin manifest id 契约(charset + 非 ./..),否则状态索引错配 +
  // "See all" query 注入。长度上限仍保留(charset 不限长)。
  if (
    typeof e.id !== 'string' ||
    e.id.length === 0 ||
    e.id.length > MP_ID_MAX ||
    !isValidPluginId(e.id)
  )
    return false;
  if (
    typeof e.name !== 'string' ||
    e.name.length === 0 ||
    e.name.length > MP_NAME_MAX
  )
    return false;
  if (typeof e.author !== 'string' || e.author.length > MP_AUTHOR_MAX)
    return false;
  // repo 必须是两段安全 GitHub owner/name(否则 entryToGitUrl/ManifestUrl 拼出垃圾/异常 URL)。
  // 边界(E107):段级校验拒 ./.. 点段(防 URL 归一化路径穿越)。
  if (
    typeof e.repo !== 'string' ||
    e.repo.length > MP_REPO_MAX ||
    !isValidRepo(e.repo)
  )
    return false;
  if (
    e.description !== undefined &&
    (typeof e.description !== 'string' || e.description.length > MP_DESC_MAX)
  )
    return false;
  if (
    e.authorUrl !== undefined &&
    (typeof e.authorUrl !== 'string' ||
      e.authorUrl.length > MP_URL_MAX ||
      !isHttpUrl(e.authorUrl)) // 边界(E108):只接受 http/https,拒 javascript:/file: 等
  )
    return false;
  if (
    e.branch !== undefined &&
    (typeof e.branch !== 'string' || !isValidBranch(e.branch)) // 边界(E104):段级校验
  )
    return false;
  if (e.verified !== undefined && typeof e.verified !== 'boolean') return false;
  if (e.tags !== undefined) {
    if (!Array.isArray(e.tags) || e.tags.length > MP_TAGS_COUNT_MAX)
      return false;
    if (
      !e.tags.every((t) => typeof t === 'string' && t.length <= MP_TAG_MAX)
    )
      return false;
  }
  return true;
}

/** 把 entry.repo 拼成 git clone URL,供 installFromGit 用. */
export function entryToGitUrl(entry: MarketplaceEntry): string {
  return `https://github.com/${entry.repo}.git`;
}

/** 把 entry.repo + branch 拼成 raw manifest URL. */
export function entryToManifestUrl(entry: MarketplaceEntry): string {
  const branch = entry.branch ?? 'main';
  return `https://raw.githubusercontent.com/${entry.repo}/${branch}/manifest.json`;
}
