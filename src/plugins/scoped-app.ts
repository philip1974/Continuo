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
  PluginMcpApi,
  PluginNetworkApi,
  PluginPermissionApi,
  PluginShellApi,
} from './types';
import type { PluginMcpToolSpec } from './registries/PluginMcpRegistry';
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

function missingPluginFsToken(): never {
  throw new Error('[plugin-fs] no token bound');
}

function makeFs(
  pluginId: string,
  store: PermissionStore | null,
  token?: string,
): PluginFsApi {
  return {
    requestScope: async (scopes) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.requestScope(
        token ?? missingPluginFsToken(),
        scopes,
      );
    },
    readFile: async (path) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.readFile(token ?? missingPluginFsToken(), path);
    },
    writeFile: async (path, content) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.writeFile(
        token ?? missingPluginFsToken(),
        path,
        content,
      );
    },
    listDir: async (path) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.listDir(token ?? missingPluginFsToken(), path);
    },
    stat: async (path) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.stat(token ?? missingPluginFsToken(), path);
    },
    lstat: async (path) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.lstat(token ?? missingPluginFsToken(), path);
    },
    realpath: async (path) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.realpath(token ?? missingPluginFsToken(), path);
    },
    mkdir: async (path, opts) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.mkdir(
        token ?? missingPluginFsToken(),
        path,
        opts,
      );
    },
    rename: async (src, dst) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.rename(token ?? missingPluginFsToken(), src, dst);
    },
    rm: async (path, opts) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.rm(token ?? missingPluginFsToken(), path, opts);
    },
    cp: async (src, dst, opts) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.cp(
        token ?? missingPluginFsToken(),
        src,
        dst,
        opts,
      );
    },
    readGitBlob: async (repoDir, sha) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.readGitBlob(
        token ?? missingPluginFsToken(),
        repoDir,
        sha,
      );
    },
    atomicReplaceWithinScope: async (staging, final, opts) => {
      await ensurePerm(pluginId, 'fs', store);
      return coApi.pluginFsRaw.atomicReplaceWithinScope(
        token ?? missingPluginFsToken(),
        staging,
        final,
        opts,
      );
    },
    userHome: async () => {
      // No fs permission required - only returns home path string (not fs access).
      return coApi.pluginFsRaw.userHome(token ?? missingPluginFsToken());
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

function makeShell(
  pluginId: string,
  store: PermissionStore | null,
): PluginShellApi {
  return {
    async exec(cmd, args, opts) {
      await ensurePerm(pluginId, 'shell', store);
      const r = await coApi.shell.exec({
        cmd,
        args: [...args],
        cwd: opts?.cwd,
        env: opts?.env,
        timeoutMs: opts?.timeoutMs,
        input: opts?.input,
        maxOutputBytes: opts?.maxOutputBytes,
      });
      if (!r.ok) throw new Error(`[shell.exec] ${r.code}: ${r.message}`);
      return r.data;
    },
    execStream(cmd, args, opts) {
      let raw:
        | ReturnType<typeof coApi.pluginShellStreamRaw.execStream>
        | null = null;
      let startPromise:
        | Promise<ReturnType<typeof coApi.pluginShellStreamRaw.execStream>>
        | null = null;
      const start = async () => {
        if (raw) return raw;
        if (!startPromise) {
          startPromise = (async () => {
            await ensurePerm(pluginId, 'shell', store);
            raw = coApi.pluginShellStreamRaw.execStream(cmd, args, opts);
            return raw;
          })();
        }
        return startPromise;
      };
      return {
        chunks: {
          [Symbol.asyncIterator]() {
            let iterator:
              | AsyncIterator<{ stream: 'stdout' | 'stderr'; chunk: Uint8Array }>
              | null = null;
            return {
              async next() {
                const stream = await start();
                iterator ??= stream.chunks[Symbol.asyncIterator]();
                return iterator.next();
              },
            };
          },
        },
        done: start().then((stream) => stream.done),
      };
    },
  };
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

function makeMcp(
  pluginId: string,
  store: PermissionStore | null,
  registry: CoApp['mcp'],
): PluginMcpApi {
  return {
    async register<I, O>(spec: PluginMcpToolSpec<I, O>) {
      await ensurePerm(pluginId, 'mcp-tools', store);
      return registry.register(spec, pluginId);
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
  token?: string,
): CoPluginApp {
  // Omit coApp.mcp(单例 registry)→ 替换为 per-plugin scope wrapper,
  // 其它字段直通。
  const { mcp: registry, ...rest } = coApp;
  return {
    ...rest,
    fs: makeFs(pluginId, store, token),
    network: makeNetwork(pluginId, store),
    shell: makeShell(pluginId, store),
    clipboard: makeClipboard(pluginId, store),
    permission: makePermission(pluginId, store),
    mcp: makeMcp(pluginId, store, registry),
  };
}
