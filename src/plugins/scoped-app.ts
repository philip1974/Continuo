// ScopedApp(M-Plugin v5 Phase 1):per-plugin 包装的 LMApp。
//
// 解决"app 是单例 plugin 无法分辨调用方"难题:每次 activateEntry 都
// new 一个 ScopedApp,fs/network/clipboard/permission 知道自己服务哪个
// pluginId,后续 Phase 3 加 runtime gating 时各方法可调
// store.get(pluginId) 检查授权。
//
// Phase 1 fs/network/clipboard 直接转发到 window.api / globalThis.fetch,
// 不做权限检;permission.check / granted 真读 store。

import type {
  LMApp,
  LMPluginApp,
  PluginClipboardApi,
  PluginFsApi,
  PluginNetworkApi,
  PluginPermissionApi,
  PluginShellApi,
} from './types';
import type { PermissionKey, PermissionStore } from './permissions';

interface WindowApiShape {
  fs?: {
    readFile(path: string): Promise<{ ok: true; data: string } | { ok: false; code: string; message: string }>;
    writeFile(
      path: string,
      content: string,
    ): Promise<{ ok: true; data: void } | { ok: false; code: string; message: string }>;
    listDir(
      path: string,
    ): Promise<
      | { ok: true; data: readonly import('../../electron/shared/fs-entry').FileEntry[] }
      | { ok: false; code: string; message: string }
    >;
  };
}

function getApi(): WindowApiShape {
  // 通过 globalThis 拿,jsdom 测试时 window.api 可能不存在 → 让方法抛
  return (globalThis as unknown as { window?: { api?: WindowApiShape } }).window?.api ?? {};
}

function makeFs(_pluginId: string): PluginFsApi {
  return {
    async readFile(path) {
      const fs = getApi().fs;
      if (!fs) throw new Error('window.api.fs 未注入(jsdom?)');
      const r = await fs.readFile(path);
      if (!r.ok) throw new Error(`[fs.readFile] ${r.code}: ${r.message}`);
      return r.data;
    },
    async writeFile(path, content) {
      const fs = getApi().fs;
      if (!fs) throw new Error('window.api.fs 未注入(jsdom?)');
      const r = await fs.writeFile(path, content);
      if (!r.ok) throw new Error(`[fs.writeFile] ${r.code}: ${r.message}`);
    },
    async listDir(path) {
      const fs = getApi().fs;
      if (!fs) throw new Error('window.api.fs 未注入(jsdom?)');
      const r = await fs.listDir(path);
      if (!r.ok) throw new Error(`[fs.listDir] ${r.code}: ${r.message}`);
      return r.data;
    },
  };
}

function makeNetwork(_pluginId: string): PluginNetworkApi {
  return {
    fetch(url, init) {
      // Phase 1:直接转发 globalThis.fetch
      return globalThis.fetch(url, init);
    },
  };
}

function makeShell(_pluginId: string): PluginShellApi {
  // Phase 3 实装
  return {};
}

function makeClipboard(_pluginId: string): PluginClipboardApi {
  return {
    async readText() {
      return navigator.clipboard.readText();
    },
    async writeText(text) {
      return navigator.clipboard.writeText(text);
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
 * 把 lmApp 包成 per-plugin LMPluginApp。Plugin constructor 拿到的就是它。
 *
 * - 原有贡献点字段(panels/commands/...)直通 lmApp 引用,不重复 new
 * - fs/network/clipboard/permission 是 per-plugin 闭包,持 pluginId
 * - shell 是 placeholder(Phase 3)
 */
export function createScopedApp(
  lmApp: LMApp,
  pluginId: string,
  store: PermissionStore | null,
): LMPluginApp {
  return {
    ...lmApp,
    fs: makeFs(pluginId),
    network: makeNetwork(pluginId),
    shell: makeShell(pluginId),
    clipboard: makeClipboard(pluginId),
    permission: makePermission(pluginId, store),
  };
}
