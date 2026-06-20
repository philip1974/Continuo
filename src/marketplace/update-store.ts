// 更新检查 store(Phase 3)。
//
// 启动时静默 refresh:拉索引 → 每个 entry 拉远程 manifest → 跟本地
// PluginManager.listAll 的 manifest.version 比较 → 攒成 available[]。
// IconSidebar 角标 + MarketplaceTab 按钮订阅本 store。
//
// 一次 refresh 可能并发 N 个 fetch(N = index.length),N < 100 时一次
// burst 没问题;真大了再分批。

import { create } from 'zustand';
import { getUserPluginManager } from '@/plugins/PluginManager';
import { fetchMarketplaceIndex, fetchPluginManifest } from './fetcher';
import { isNewerVersion } from './semver';
import type { MarketplaceEntry } from './types';

export interface AvailableUpdate {
  readonly id: string;
  readonly name: string;
  readonly from: string; // 本地 installed version
  readonly to: string;   // 远程 latest version
  readonly entry: MarketplaceEntry;
}

interface UpdateState {
  /** id → 远程最新 version(已知的). */
  readonly remoteVersions: ReadonlyMap<string, string>;
  /** 本地装了 + 有更新可用的清单. */
  readonly available: readonly AvailableUpdate[];
  /** 是否正在 refresh. */
  readonly checking: boolean;
  /** 最后一次 refresh 时间(ms),null 表示还没跑过. */
  readonly lastCheckedAt: number | null;

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

export const useUpdateStore = create<UpdateState>((set) => ({
  remoteVersions: new Map(),
  available: [],
  checking: false,
  lastCheckedAt: null,

  dismiss: (id) =>
    set((s) => {
      if (!s.available.some((u) => u.id === id)) return s;
      return { available: s.available.filter((u) => u.id !== id) };
    }),

  refresh: async () => {
    const myGen = ++refreshGen;
    set({ checking: true });
    try {
      const entries = await fetchMarketplaceIndex();
      const remoteVersions = new Map<string, string>();
      const entriesById = new Map<string, MarketplaceEntry>();
      for (const e of entries) entriesById.set(e.id, e);

      // 并发拉所有 manifest;单个失败不影响其它
      const results = await Promise.allSettled(
        entries.map((e) => fetchPluginManifest(e)),
      );
      for (let i = 0; i < entries.length; i++) {
        const r = results[i];
        if (r && r.status === 'fulfilled') {
          remoteVersions.set(r.value.id, r.value.version);
        }
      }

      // 跟本地 PluginManager 比较
      const mgr = getUserPluginManager();
      const installed = mgr ? mgr.listAll() : [];
      const available: AvailableUpdate[] = [];
      for (const item of installed) {
        const remoteV = remoteVersions.get(item.id);
        if (!remoteV) continue;
        if (!isNewerVersion(remoteV, item.manifest.version)) continue;
        const entry = entriesById.get(item.id);
        if (!entry) continue;
        available.push({
          id: item.id,
          name: item.manifest.name,
          from: item.manifest.version,
          to: remoteV,
          entry,
        });
      }

      // 更晚的 refresh 已开始 → 丢弃本次过期结果(由最新代际负责落库 + 清 checking)
      if (myGen !== refreshGen) return;
      set({
        remoteVersions,
        available,
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
