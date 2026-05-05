// ScopedApp(M-Plugin v5 Phase 1-3):per-plugin 包装的 CoApp。
//
// 解决"app 是单例 plugin 无法分辨调用方"难题:每次 activateEntry 都
// new 一个 ScopedApp,fs/network/clipboard/permission 知道自己服务哪个
// pluginId,各方法调 store.get(pluginId) 检查授权。
//
// Phase 3:fs/network/clipboard 各方法接入 permission.check,未授抛
// PermissionError,plugin 须 try/catch 优雅降级。
// store=null(向后兼容/测试)时跳过检查直接转发,permission.check 一律 true。

import type {
  CoApp,
  CoPluginApp,
  PluginClipboardApi,
  PluginFsApi,
  PluginNetworkApi,
  PluginPermissionApi,
  PluginShellApi,
} from './types';
import {
  PermissionError,
  type PermissionKey,
  type PermissionStore,
} from './permissions';
import { getCachedClipboard, getCachedFetch } from './sandbox-sweep';
import { coApi } from '@/lib/co-api';

/** 检查 plugin 是否拿到 perm 授权;未授抛 PermissionError. store=null 跳过检查. */
async function ensurePerm(
  pluginId: string,
  perm: PermissionKey,
  store: PermissionStore | null,
): Promise<void> {
  if (!store) return;
  const decisions = await store.get(pluginId);
  const granted = decisions.some(
    (d) => d.permission === perm && d.granted,
  );
  if (!granted) throw new PermissionError(perm);
}

function makeFs(pluginId: string, store: PermissionStore | null): PluginFsApi {
  return {
    async readFile(path) {
      await ensurePerm(pluginId, 'fs', store);
      const r = await coApi.fs.readFile(path);
      if (!r.ok) throw new Error(`[fs.readFile] ${r.code}: ${r.message}`);
      return r.data;
    },
    async writeFile(path, content) {
      await ensurePerm(pluginId, 'fs', store);
      const r = await coApi.fs.writeFile(path, content);
      if (!r.ok) throw new Error(`[fs.writeFile] ${r.code}: ${r.message}`);
    },
    async listDir(path) {
      await ensurePerm(pluginId, 'fs', store);
      const r = await coApi.fs.listDir(path);
      if (!r.ok) throw new Error(`[fs.listDir] ${r.code}: ${r.message}`);
      return r.data;
    },
  };
}

function makeNetwork(
  pluginId: string,
  store: PermissionStore | null,
): PluginNetworkApi {
  return {
    async fetch(url, init) {
      await ensurePerm(pluginId, 'network', store);
      // 用 module 顶部 cached raw fetch,sandboxSweep 后 globalThis.fetch
      // 已涂掉但本闭包仍能调
      return getCachedFetch()(url, init);
    },
  };
}

function makeShell(_pluginId: string): PluginShellApi {
  // Phase 4+ 实装(暴露 spawn / exec)
  return {};
}

function makeClipboard(
  pluginId: string,
  store: PermissionStore | null,
): PluginClipboardApi {
  return {
    async readText() {
      await ensurePerm(pluginId, 'clipboard', store);
      return getCachedClipboard().readText();
    },
    async writeText(text) {
      await ensurePerm(pluginId, 'clipboard', store);
      return getCachedClipboard().writeText(text);
    },
  };
}

function makePermission(
  pluginId: string,
  store: PermissionStore | null,
): PluginPermissionApi {
  return {
    async check(perm) {
      if (!store) return true; // 无 store(向后兼容/测试)→ 视为已授
      const decisions = await store.get(pluginId);
      return decisions.some((d) => d.permission === perm && d.granted);
    },
    async granted() {
      if (!store) return [];
      const decisions = await store.get(pluginId);
      const out: PermissionKey[] = [];
      for (const d of decisions) if (d.granted) out.push(d.permission);
      return out;
    },
  };
}

/**
 * 把 coApp 包成 per-plugin CoPluginApp。Plugin constructor 拿到的就是它。
 *
 * - 原有贡献点字段(panels/commands/...)直通 coApp 引用,不重复 new
 * - fs/network/clipboard/permission 是 per-plugin 闭包,持 pluginId
 * - shell 是 placeholder(Phase 3)
 */
export function createScopedApp(
  coApp: CoApp,
  pluginId: string,
  store: PermissionStore | null,
): CoPluginApp {
  return {
    ...coApp,
    fs: makeFs(pluginId, store),
    network: makeNetwork(pluginId, store),
    shell: makeShell(pluginId),
    clipboard: makeClipboard(pluginId, store),
    permission: makePermission(pluginId, store),
  };
}
