// 插件商店索引 fetcher(Phase 1)。
//
// 拉 raw.githubusercontent.com 上的 index.json,1h in-memory + sessionStorage
// cache。GitHub raw 60/hr 不 auth,缓存 1h 单用户撞不墙。
// fetch 抛错时 fallback 上次 cache(用户离线也能浏览历史)。
//
// 注意:用 getCachedFetch() 取 raw fetch ref(PROD sandboxSweep 把
// globalThis.fetch 涂掉了防 plugin 绕权限,LM 自家代码必须走 cached ref)。

import { getCachedFetch } from '../plugins/sandbox-sweep';
import { entryToManifestUrl, type MarketplaceEntry } from './types';
import { createSessionCache } from './session-cache';

const INDEX_URL =
  'https://raw.githubusercontent.com/philip1974/continuo-plugins/main/index.json';

// 可维护性 M19:1h sessionStorage 缓存样板复用 createSessionCache(与 reviews-fetcher 共用)。
const indexCache = createSessionCache<readonly MarketplaceEntry[]>({
  key: 'continuo:marketplace:index',
  ttlMs: 60 * 60 * 1000,
  validate: (d): d is readonly MarketplaceEntry[] => Array.isArray(d),
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
    const entries = (await r.json()) as readonly MarketplaceEntry[];
    if (!Array.isArray(entries)) throw new Error('index 非数组');
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
  const json = (await r.json()) as Partial<RemoteManifestSnapshot>;
  if (
    typeof json.id !== 'string' ||
    typeof json.name !== 'string' ||
    typeof json.version !== 'string'
  ) {
    throw new Error('manifest 缺 id / name / version');
  }
  return { id: json.id, name: json.name, version: json.version };
}
