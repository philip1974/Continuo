// 更新检查 store(Phase 3)。
//
// 启动时静默 refresh:拉索引 → 为已安装插件命中的 entry 拉远程 manifest → 存远端版本表。
// 可用更新 = 已安装列表 × 远端版本 × dismissed 现算(useAvailableUpdates),
// IconSidebar 角标 + MarketplaceTab 按钮都读它。
//
// 边界(E234,E216 并发 fan-out 同族):一次 refresh 的 manifest 拉取改用有界并发池
// (MAX_MANIFEST_FETCH_CONCURRENCY)。relevant ≤ 已安装命中的 entries,而 marketplace index 上限 4096、
// 本地插件目录上限可达 1024 —— 旧 `Promise.allSettled(relevant.map(...))` 会同时发起数百到上千个 fetch,
// 网络/Promise/解析尖峰且把 GitHub raw 打满。固定并发池钳定最大在途数,保留 allSettled 单失败不影响其它语义。

import { useMemo } from 'react';
import { create } from 'zustand';
import { getUserPluginManager, type PluginListItem } from '@/plugins/PluginManager';
import { useUserPluginList } from '@/plugins/use-user-plugin-list';
import { allSettledWithConcurrency } from '@/lib/map-with-concurrency';
import { fetchMarketplaceIndex, fetchPluginManifest } from './fetcher';
import { isNewerVersion, isValidSemver } from './semver';
import type { MarketplaceEntry } from './types';
import { createLatestGuard } from '@/lib/latest-wins';
import { APP_VERSION } from '@/lib/app-version';
import { admitManifestVersion } from '@/plugins/manifest';

// 边界(E234):manifest 拉取最大并发数。8-16 区间足以掩盖网络延迟又不打爆本地/远端。
export const MAX_MANIFEST_FETCH_CONCURRENCY = 12;

export interface AvailableUpdate {
  readonly id: string;
  readonly to: string; // 远程 latest version
}

/** 被 dismiss 的更新:只压制「这份已安装实例(manifest 引用)+ 这个目标版本」。 */
interface DismissedUpdate {
  readonly manifest: PluginListItem['manifest'];
  readonly to: string;
}

const EMPTY_AVAILABLE_UPDATES: readonly AvailableUpdate[] = [];
const EMPTY_INSTALLED_PLUGINS: readonly PluginListItem[] = [];
const EMPTY_REMOTE_VERSIONS: ReadonlyMap<string, string> = new Map();

interface UpdateState {
  /**
   * 最近一次 refresh 拉到的远端版本表(id → 合法 semver)。「有哪些可用更新」不存成状态,由
   * computeAvailableUpdates / useAvailableUpdates 用当前已安装列表现算 —— 任何窗口卸载 / 更新插件
   * (本窗口经 handleUninstalled / 文件监视 reload 改列表)都即时反映到角标与卡片,无需手工同步。
   */
  readonly remoteVersions: ReadonlyMap<string, string>;
  /**
   * 更新成功后的乐观压制(id → 当时的已安装实例 + 目标版本)。覆盖安装后要等 reload 才推进内存版本,
   * 期间(或 reload 失败时)按钮仍会显示、可被重复点击触发二次覆盖安装;压制到该实例被替换
   * (reload 成功 / 卸载重装)为止,远端出现更新版本也会重新显示。
   */
  readonly dismissed: ReadonlyMap<string, DismissedUpdate>;

  refresh(): Promise<void>;
  /** 更新刚成功时乐观收起该 id 当前的可用更新(无可用更新则 no-op)。 */
  dismiss(id: string): void;
}

// 单调代际:并发 refresh 时,慢的网络请求可能在快的之后才 resolve。捕获本次
// 代际,只有仍是最新代际时才落库,避免过期结果覆盖更新的结果(mirror settings.store
// 的 gen 乱序防护)。
const refreshGuard = createLatestGuard();

function readInstalled(): readonly PluginListItem[] {
  const mgr = getUserPluginManager();
  return mgr ? mgr.listAll() : EMPTY_INSTALLED_PLUGINS;
}

/** 已安装 × 远端版本 × dismissed → 可用更新(无则返回稳定空数组)。 */
export function computeAvailableUpdates(
  installed: readonly PluginListItem[],
  remoteVersions: ReadonlyMap<string, string>,
  dismissed: ReadonlyMap<string, DismissedUpdate>,
): readonly AvailableUpdate[] {
  if (remoteVersions.size === 0) return EMPTY_AVAILABLE_UPDATES;
  let available: AvailableUpdate[] | null = null;
  for (const item of installed) {
    const remoteV = remoteVersions.get(item.id);
    if (!remoteV || !isNewerVersion(remoteV, item.manifest.version)) continue;
    const d = dismissed.get(item.id);
    if (d && d.manifest === item.manifest && d.to === remoteV) continue;
    (available ??= []).push({ id: item.id, to: remoteV });
  }
  return available ?? EMPTY_AVAILABLE_UPDATES;
}

/** 订阅当前窗口的可用更新(已安装列表或 store 变化即重算)。 */
export function useAvailableUpdates(): readonly AvailableUpdate[] {
  const installed = useUserPluginList();
  const remoteVersions = useUpdateStore((s) => s.remoteVersions);
  const dismissed = useUpdateStore((s) => s.dismissed);
  return useMemo(
    () => computeAvailableUpdates(installed, remoteVersions, dismissed),
    [installed, remoteVersions, dismissed],
  );
}

export const useUpdateStore = create<UpdateState>((set) => ({
  remoteVersions: EMPTY_REMOTE_VERSIONS,
  dismissed: new Map(),

  dismiss: (id) =>
    set((s) => {
      const item = readInstalled().find((p) => p.id === id);
      const to = s.remoteVersions.get(id);
      if (!item || !to || !isNewerVersion(to, item.manifest.version)) return s;
      const dismissed = new Map(s.dismissed);
      dismissed.set(id, { manifest: item.manifest, to });
      return { dismissed };
    }),

  refresh: async () => {
    const isLatest = refreshGuard.begin();
    // 没有可能的更新 → 清空(已为空则不通知订阅者)。
    const clearRemote = (): void =>
      set((s) => (s.remoteVersions.size === 0 ? s : { remoteVersions: EMPTY_REMOTE_VERSIONS }));
    try {
      // 先读本地已安装(打磨 R54):只有已安装插件可能"有更新",故按已安装规模裁剪
      // 网络。没装任何 marketplace 插件 → 直接落空,跳过 index + 全部 manifest 请求。
      const installed = readInstalled();
      if (installed.length === 0) {
        if (!isLatest()) return;
        clearRemote();
        return;
      }
      const installedIds = new Set<string>();
      for (const item of installed) installedIds.add(item.id);

      const entries = await fetchMarketplaceIndex();
      let relevant: MarketplaceEntry[] | null = null;
      let relevantCount = 0;
      for (const e of entries) {
        if (installedIds.has(e.id)) {
          relevant ??= new Array<MarketplaceEntry>(entries.length);
          relevant[relevantCount++] = e;
        }
      }
      if (relevant === null) {
        if (!isLatest()) return;
        clearRemote();
        return;
      }
      relevant.length = relevantCount;
      const remoteVersions = new Map<string, string>();

      // 只拉「已安装插件命中的 entries」的 manifest(M ≤ N);单个失败不影响其它。
      // 边界(E234):有界并发池(MAX_MANIFEST_FETCH_CONCURRENCY)钳定最大在途 fetch 数,
      // 防数百到上千个 manifest 请求同时发起(index 4096 / 本地目录 1024)打爆网络/renderer。
      const results = await allSettledWithConcurrency(
        relevant,
        MAX_MANIFEST_FETCH_CONCURRENCY,
        (e) => fetchPluginManifest(e),
      );
      for (let i = 0; i < relevant.length; i++) {
        const r = results[i];
        if (r && r.status === 'fulfilled') {
          // 远端 manifest.id ≠ entry.id:entry 指向另一身份的仓库,其版本不能当作任何已装插件的
          // 更新(否则错配,且「更新」会去覆盖安装别的仓库;main 侧 expectedId 也会拒)。跳过。
          if (r.value.id !== relevant[i]!.id) {
            console.warn(
              `[update-store] skip ${relevant[i]!.id}: remote manifest id ${r.value.id} mismatch`,
            );
            continue;
          }
          // 边界(E7):远端 manifest.version 不是合法 semver(畸形/超长数字段)→ 不记,不进入
          // isNewerVersion 的字符串 fallback(否则 '999…' 字符串序仍可能 > 安装版误显更新)。
          if (!isValidSemver(r.value.version)) continue;
          // 远端版本要求更高应用版本(minLMVersion):装上也被准入拒载(main 安装同样拒),不算可用更新。
          if (!admitManifestVersion(r.value, APP_VERSION).ok) continue;
          remoteVersions.set(r.value.id, r.value.version);
        }
      }

      // 更晚的 refresh 已开始 → 丢弃本次过期结果(由最新代际负责落库)
      if (!isLatest()) return;
      if (remoteVersions.size === 0) clearRemote();
      else set({ remoteVersions });
    } catch (err) {
      console.warn('[update-store] refresh failed', err);
    }
  },
}));
