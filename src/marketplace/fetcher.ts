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

const INDEX_URL =
  'https://raw.githubusercontent.com/philip1974/continuo-plugins/main/index.json';

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_KEY = 'continuo:marketplace:index';

interface CachedIndex {
  readonly fetchedAt: number;
  readonly entries: readonly MarketplaceEntry[];
}

let memoryCache: CachedIndex | null = null;

function readSessionCache(): CachedIndex | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedIndex;
    if (typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.entries))
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSessionCache(cache: CachedIndex): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* sessionStorage 满 / 禁用 → ignore,memory cache 还在 */
  }
}

function isFresh(cache: CachedIndex): boolean {
  return Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

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
  if (!memoryCache) memoryCache = readSessionCache();
  if (!forceRefresh && memoryCache && isFresh(memoryCache)) {
    return memoryCache.entries;
  }

  try {
    const r = await getCachedFetch()(INDEX_URL, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const entries = (await r.json()) as readonly MarketplaceEntry[];
    if (!Array.isArray(entries)) throw new Error('index 非数组');
    const next: CachedIndex = { fetchedAt: Date.now(), entries };
    memoryCache = next;
    writeSessionCache(next);
    return entries;
  } catch (err) {
    if (memoryCache) {
      console.warn(
        '[marketplace] fetchIndex failed, falling back to cache',
        err,
      );
      return memoryCache.entries;
    }
    throw err;
  }
}

/** 测试用:重置 in-memory + sessionStorage cache. */
export function _resetMarketplaceCacheForTest(): void {
  memoryCache = null;
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    /* */
  }
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
