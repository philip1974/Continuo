// 插件商店索引 fetcher(Phase 1)。
//
// 拉 raw.githubusercontent.com 上的 index.json,1h in-memory + sessionStorage
// cache。GitHub raw 60/hr 不 auth,缓存 1h 单用户撞不墙。
// fetch 抛错时 fallback 上次 cache(用户离线也能浏览历史)。
//
// 注意:用 getCachedFetch() 取 raw fetch ref(PROD sandboxSweep 把
// globalThis.fetch 涂掉了防 plugin 绕权限,LM 自家代码必须走 cached ref)。

import { getCachedFetch } from '../plugins/sandbox-sweep';
import { ManifestSchema } from '../plugins/manifest';
import {
  entryToManifestUrl,
  isValidMarketplaceEntry,
  type MarketplaceEntry,
} from './types';
import { createSessionCache } from './session-cache';
import { readResponseTextCapped } from '../../electron/shared/read-capped';

const INDEX_URL =
  'https://raw.githubusercontent.com/philip1974/continuo-plugins/main/index.json';

// 边界(E64,E57 reviews 同族,renderer 网络输入):index.json/manifest.json 是外部仓库数据。
// 此前直接 await r.json() 无响应体上限,恶意/异常响应可让 renderer 解析超大 JSON / 超大数组
// → 内存/CPU 峰值、UI 卡死。读 text 时先按 Content-Length + 字节上限拦,再 JSON.parse(挡把超大
// 字符串解析成更大对象树);index 顶层数组再加条目数硬上限。
const MAX_INDEX_BYTES = 4 * 1024 * 1024; // index.json 响应体上限
const MAX_MANIFEST_BYTES = 1024 * 1024; // manifest.json 响应体上限(同 main MANIFEST_MAX_BYTES)
export const MAX_INDEX_ENTRIES = 4096; // index 顶层数组条目硬上限

async function readJsonCapped(r: Response, maxBytes: number): Promise<unknown> {
  // 边界(E124):流式按真实字节硬截断(Content-Length 可缺失/伪造,text.length 是 char 数非字节)。
  const text = await readResponseTextCapped(
    r,
    maxBytes,
    () => new Error('MARKETPLACE_RESPONSE_TOO_LARGE'),
  );
  return JSON.parse(text);
}

export function selectValidMarketplaceEntries(
  entries: readonly unknown[],
  maxEntries: number = entries.length,
): MarketplaceEntry[] {
  const count = Math.min(entries.length, maxEntries);
  const out = new Array<MarketplaceEntry>(count);
  let outCount = 0;
  for (let i = 0; i < count; i++) {
    const entry = entries[i];
    if (isValidMarketplaceEntry(entry)) out[outCount++] = entry;
  }
  out.length = outCount;
  return out;
}

// 可维护性 M19:1h sessionStorage 缓存样板复用 createSessionCache(与 reviews-fetcher 共用)。
const indexCache = createSessionCache<readonly MarketplaceEntry[]>({
  key: 'continuo:marketplace:index',
  ttlMs: 60 * 60 * 1000,
  // 边界(E2):persisted sessionStorage 可能被外部篡改/旧格式 → 不仅校验是数组,还逐 entry 校验
  // 形态,任一非法即视为缓存不可用(返 false → 当无缓存重新拉)。fetch 路径只缓存已过滤的合法
  // entry,故正常情况此处全通过。
  // 边界(E121,E111 reviews 读/写不对称同族):fresh path 把 index 截到 MAX_INDEX_ENTRIES,但
  // 缓存读端此前无数量上限 → 被篡改/旧版本 sessionStorage 可塞 raw cap(16MiB)内的大量合法小
  // entry,绕过截断进入 filter/排序/渲染/update-check 放大。读端镜像同款数量上限,超量当 cache miss。
  validate: (d): d is readonly MarketplaceEntry[] =>
    Array.isArray(d) &&
    d.length <= MAX_INDEX_ENTRIES &&
    d.every(isValidMarketplaceEntry),
});

/**
 * 拉索引。1h cache,非强制刷新且 cache 新鲜直接返。
 *
 * - 网络成功 → 更新 cache 返新数据
 * - 网络失败 + 有 cache → 返 cache(过期也返,better than nothing)
 * - 网络失败 + 无 cache → 抛
 */
export async function fetchMarketplaceIndex(
  forceRefresh = false,
): Promise<readonly MarketplaceEntry[]> {
  if (!forceRefresh) {
    const fresh = indexCache.getFresh();
    if (fresh) return fresh;
  }

  try {
    const r = await getCachedFetch()(INDEX_URL, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    // 边界(E64):响应体上限 + 解析前拦,而非 await r.json() 无界解析。
    const raw = (await readJsonCapped(r, MAX_INDEX_BYTES)) as unknown;
    // i18n(I5):抛稳定 code(非中文 prose),caller catch 按 errors.<CODE> catalog 本地化
    // 渲染(en/ko 不再泄漏中文)。网络/HTTP 等动态错误仍走原 message(无 catalog 回退)。
    if (!Array.isArray(raw)) throw new Error('MARKETPLACE_INDEX_INVALID');
    // 边界(E64):顶层数组条目数硬上限 —— 超大数组先截断,再逐 entry 校验/缓存(防超大 index
    // 数组在 filter/排序/渲染/sessionStorage 缓存放大)。
    const entryCount = Math.min(raw.length, MAX_INDEX_ENTRIES);
    if (entryCount < raw.length) {
      console.warn(
        `[marketplace] index truncated to ${MAX_INDEX_ENTRIES} entries (had ${raw.length})`,
      );
    }
    // 边界(E2):逐 entry 校验形态,丢弃畸形项(null/缺 repo/字段类型错),防其在 filter/渲染/
    // 更新检查里触发 TypeError 崩面板,或拼出 github.com/undefined.git。一个坏社区条目不应让整个
    // 市场不可用 → 过滤而非整体拒绝;只缓存合法 entry。
    const entries = selectValidMarketplaceEntries(raw, entryCount);
    if (entries.length < entryCount) {
      console.warn(
        `[marketplace] dropped ${entryCount - entries.length} malformed index entr${
          entryCount - entries.length === 1 ? 'y' : 'ies'
        }`,
      );
    }
    indexCache.set(entries);
    return entries;
  } catch (err) {
    const stale = indexCache.getStale();
    if (stale) {
      console.warn(
        '[marketplace] fetchIndex failed, falling back to cache',
        err,
      );
      return stale;
    }
    throw err;
  }
}

/** 测试用:重置 in-memory + sessionStorage cache. */
export function _resetMarketplaceCacheForTest(): void {
  indexCache.reset();
}

/** 远程 plugin manifest 的最少字段,update check 用. */
export interface RemoteManifestSnapshot {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

// 边界(E80):远端 manifest snapshot 复用本地 ManifestSchema 的 id/name/version 校验
//(.max + SEMVER_RE,单一来源),防超长字段/非 semver version 进 update-store 放大渲染。
const RemoteSnapshotSchema = ManifestSchema.pick({
  id: true,
  name: true,
  version: true,
});

/**
 * 拉指定 entry 对应 plugin repo 的 manifest.json,只取 id/name/version。
 * 不缓存(每次 update check 都拉新);失败抛 caller 决定怎么处理。
 */
export async function fetchPluginManifest(
  entry: MarketplaceEntry,
): Promise<RemoteManifestSnapshot> {
  const r = await getCachedFetch()(entryToManifestUrl(entry), {
    cache: 'no-cache',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  // 边界(E64):manifest 响应体上限(同 main MANIFEST_MAX_BYTES),解析前拦。
  const json = await readJsonCapped(r, MAX_MANIFEST_BYTES);
  // 边界(E80,E74 字段上限族):远端 manifest 的 id/name/version 此前只做 string 类型校验,
  // 无字段长度 / semver 上限 —— 1MiB 内可返超长 version(如 999.999.999-<超长后缀>)进
  // update-store 的 remoteVersions/available.to,在更新按钮 tooltip/文案放大渲染。复用本地
  // ManifestSchema 的 id/name/version 校验(.max + SEMVER_RE,E74 单一来源,避免漂移),
  // 不合规 → 抛(caller 当该插件 update-check 失败跳过)。
  const parsed = RemoteSnapshotSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('remote manifest invalid id / name / version');
  }
  return {
    id: parsed.data.id,
    name: parsed.data.name,
    version: parsed.data.version,
  };
}
