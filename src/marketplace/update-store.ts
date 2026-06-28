// 更新检查 store(Phase 3)。
//
// 启动时静默 refresh:拉索引 → 每个 entry 拉远程 manifest → 跟本地
// PluginManager.listAll 的 manifest.version 比较 → 攒成 available[]。
// IconSidebar 角标 + MarketplaceTab 按钮订阅本 store。
//
// 边界(E234,E216 并发 fan-out 同族):一次 refresh 的 manifest 拉取改用有界并发池
// (MAX_MANIFEST_FETCH_CONCURRENCY)。relevant ≤ 已安装命中的 entries,而 marketplace index 上限 4096、
// 本地插件目录上限可达 1024 —— 旧 `Promise.allSettled(relevant.map(...))` 会同时发起数百到上千个 fetch,
// 网络/Promise/解析尖峰且把 GitHub raw 打满。固定并发池钳定最大在途数,保留 allSettled 单失败不影响其它语义。

import { create } from 'zustand';
import { getUserPluginManager, type PluginListItem } from '@/plugins/PluginManager';
import { allSettledWithConcurrency } from '@/lib/map-with-concurrency';
import { fetchMarketplaceIndex, fetchPluginManifest } from './fetcher';
import { isNewerVersion, isValidSemver } from './semver';
import type { MarketplaceEntry } from './types';

// 边界(E234):manifest 拉取最大并发数。8-16 区间足以掩盖网络延迟又不打爆本地/远端。
export const MAX_MANIFEST_FETCH_CONCURRENCY = 12;

export interface AvailableUpdate {
  readonly id: string;
  readonly name: string;
  readonly from: string; // 本地 installed version
  readonly to: string;   // 远程 latest version
  readonly entry: MarketplaceEntry;
}

const EMPTY_AVAILABLE_UPDATES: readonly AvailableUpdate[] = [];
const EMPTY_INSTALLED_PLUGINS: readonly PluginListItem[] = [];
const EMPTY_REMOTE_VERSIONS: ReadonlyMap<string, string> = new Map();

interface UpdateState {
  /** id → 远程最新 version(已知的). */
  readonly remoteVersions: ReadonlyMap<string, string>;
  /** 本地装了 + 有更新可用的清单. */
  readonly available: readonly AvailableUpdate[];
  /** 是否正在 refresh. */
  readonly checking: boolean;
  /** 最后一次 refresh 时间(ms),null 表示还没跑过. */
  readonly lastCheckedAt: number | null;
  /**
   * race(R78):被 dismiss 的「id → 目标版本」抑制集。dismiss(id) 只乐观删 available 不能让
   * 在途 refresh() 失效;旧 refresh 在 dismiss 之后、mgr.reload() 落地之前提交时,会用仍是
   * 旧版本的 PluginManager 快照重算出同一 update 覆盖回 available(角标/按钮复活)。refresh
   * 提交前过滤掉「id 已 dismiss 且目标版本未变」的项;远端 toVersion 变化(出现更新版本)再显示。
   */
  readonly dismissed: ReadonlyMap<string, string>;

  refresh(): Promise<void>;
  /**
   * 乐观地把某 id 从 available 摘掉(更新刚成功时)。否则更新按钮要等异步
   * refresh 完成才收起,期间用户可重复点击触发对已是最新版的二次 overwrite 安装。
   */
  dismiss(id: string): void;
}

// 单调代际:并发 refresh 时,慢的网络请求可能在快的之后才 resolve。捕获本次
// 代际,只有仍是最新代际时才落库,避免过期结果覆盖更新的结果(mirror settings.store
// 的 gen 乱序防护)。
let refreshGen = 0;

interface DismissAvailableUpdateResult {
  readonly target: AvailableUpdate;
  readonly available: readonly AvailableUpdate[];
}

export function dismissAvailableUpdateFromList(
  available: readonly AvailableUpdate[],
  id: string,
): DismissAvailableUpdateResult | null {
  let target: AvailableUpdate | null = null;
  let next: AvailableUpdate[] | null = null;
  let count = 0;
  for (let i = 0; i < available.length; i++) {
    const update = available[i]!;
    if (update.id === id) {
      if (target === null) target = update;
      if (next === null) {
        next = new Array<AvailableUpdate>(Math.max(0, available.length - 1));
        for (let j = 0; j < i; j++) {
          next[count++] = available[j]!;
        }
      }
      continue;
    }
    if (next !== null) next[count++] = update;
  }
  if (target === null || next === null) return null;
  next.length = count;
  return { target, available: count === 0 ? EMPTY_AVAILABLE_UPDATES : next };
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  remoteVersions: EMPTY_REMOTE_VERSIONS,
  available: EMPTY_AVAILABLE_UPDATES,
  checking: false,
  lastCheckedAt: null,
  dismissed: new Map(),

  dismiss: (id) =>
    set((s) => {
      const nextAvailable = dismissAvailableUpdateFromList(s.available, id);
      if (!nextAvailable) return s;
      // race(R78):记下被摘除的目标版本,供 refresh 提交前过滤,防迟到的在途 refresh 复活它。
      const dismissed = new Map(s.dismissed);
      dismissed.set(id, nextAvailable.target.to);
      return { available: nextAvailable.available, dismissed };
    }),

  refresh: async () => {
    const myGen = ++refreshGen;
    set((s) => (s.checking ? s : { checking: true }));
    try {
      // 先读本地已安装(打磨 R54):只有已安装插件可能"有更新",故按已安装规模裁剪
      // 网络。没装任何 marketplace 插件 → 直接落空,跳过 index + 全部 manifest 请求。
      const mgr = getUserPluginManager();
      const installed = mgr ? mgr.listAll() : EMPTY_INSTALLED_PLUGINS;
      if (installed.length === 0) {
        if (myGen !== refreshGen) return;
        set({
          remoteVersions: EMPTY_REMOTE_VERSIONS,
          available: EMPTY_AVAILABLE_UPDATES,
          checking: false,
          lastCheckedAt: Date.now(),
        });
        return;
      }
      const installedIds = new Set<string>();
      for (const item of installed) installedIds.add(item.id);

      const entries = await fetchMarketplaceIndex();
      let entriesById: Map<string, MarketplaceEntry> | null = null;
      let relevant: MarketplaceEntry[] | null = null;
      let relevantCount = 0;
      for (const e of entries) {
        if (installedIds.has(e.id)) {
          entriesById ??= new Map<string, MarketplaceEntry>();
          relevant ??= new Array<MarketplaceEntry>(entries.length);
          entriesById.set(e.id, e);
          relevant[relevantCount++] = e;
        }
      }
      if (relevant === null || entriesById === null) {
        if (myGen !== refreshGen) return;
        set({
          remoteVersions: EMPTY_REMOTE_VERSIONS,
          available: EMPTY_AVAILABLE_UPDATES,
          checking: false,
          lastCheckedAt: Date.now(),
        });
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
          remoteVersions.set(r.value.id, r.value.version);
        }
      }

      // race(R7):提交前用 live installed 重算,而非网络请求前拍下的旧 `installed` 快照。
      // refreshGen 只防并发 refresh,卸载/更新不 bump gen;网络期间用户卸载插件后,旧快照
      // 仍含该插件 → 会把已卸载插件重新加进 available(在 dismiss 之后落库 = 过期更新提示/
      // 角标复活)。重读当前已安装集合,卸载的插件不在其中即不会被重新加入。
      const liveMgr = getUserPluginManager();
      const liveInstalled = liveMgr ? liveMgr.listAll() : EMPTY_INSTALLED_PLUGINS;

      // race(R78):提交前读最新 dismissed(可能在本次 refresh 在途期间被 dismiss 更新)。
      const dismissed = get().dismissed;

      // 跟本地 PluginManager 比较
      let available: AvailableUpdate[] | null = null;
      let availableCount = 0;
      for (const item of liveInstalled) {
        const remoteV = remoteVersions.get(item.id);
        if (!remoteV) continue;
        // 边界(E7):远端 manifest.version 不是合法 semver(畸形/超长数字段)→ 跳过该插件更新,
        // 不进入 isNewerVersion 的字符串 fallback(否则 '999…' 字符串序仍可能 > 安装版误显更新)。
        if (!isValidSemver(remoteV)) continue;
        if (!isNewerVersion(remoteV, item.manifest.version)) continue;
        // race(R78):该 id 已被 dismiss 且目标版本未变 → 不重新加入(防 dismiss 后、reload 落地
        // 前提交的在途 refresh 用旧快照复活同一 update)。远端版本变了则 get(id)!==remoteV → 仍显示。
        if (dismissed.get(item.id) === remoteV) continue;
        const entry = entriesById.get(item.id);
        if (!entry) continue;
        available ??= new Array<AvailableUpdate>(liveInstalled.length);
        available[availableCount++] = {
          id: item.id,
          name: item.manifest.name,
          from: item.manifest.version,
          to: remoteV,
          entry,
        };
      }
      if (available !== null) available.length = availableCount;
      const nextAvailable =
        available === null ? EMPTY_AVAILABLE_UPDATES : available;

      // 更晚的 refresh 已开始 → 丢弃本次过期结果(由最新代际负责落库 + 清 checking)
      if (myGen !== refreshGen) return;
      set({
        remoteVersions,
        available: nextAvailable,
        checking: false,
        lastCheckedAt: Date.now(),
      });
    } catch (err) {
      console.warn('[update-store] refresh failed', err);
      if (myGen !== refreshGen) return;
      set({ checking: false });
    }
  },
}));
