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
  CoDockApi,
  CoEditorApi,
  CoNotificationsApi,
  CoPluginApp,
  PluginClipboardApi,
  PluginFsApi,
  PluginMcpApi,
  PluginNetworkApi,
  PluginPermissionApi,
  PluginShellApi,
} from './types';
import type { PluginMcpToolSpec } from './registries/PluginMcpRegistry';
import type { PluginDataStore } from './PluginDataStore';
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
      const entries = await coApi.pluginFsRaw.listDir(
        token ?? missingPluginFsToken(),
        path,
      );
      const parent = path.replace(/[\\/]+$/, '');
      return entries.map((entry) => ({
        path: `${parent}/${entry.name}`,
        name: entry.name,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
      }));
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

// 可维护性 M7:shell stream chunk(与 preload 镜像)。迭代器 yield 此类型,结束值为 void
// (`{ value: undefined, done: true }`),用类型表达迭代器结束语义,免 `undefined as never`。
type ShellChunk = { stream: 'stdout' | 'stderr'; chunk: Uint8Array };

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
      const done = start()
        .then((stream) => stream.done)
        .then((result) => ({
          exitCode: result.exitCode ?? -1,
          signal: result.signal,
        }));
      // done 是急切求值:start() 的 ensurePerm 在缺 shell 权限时立即 reject。若插件
      // 只迭代 chunks(合法用法,chunks 路径会把同一错误抛给 for-await)而从不引用 done,
      // 这个 reject 无人处理 → renderer unhandledrejection 噪声。挂一个 no-op handler 把
      // done 标记为「已处理」(不改变返回给插件的 done:真实 await done 仍能看到 reject)。
      // 见第十四轮 P2-AN。
      done.catch(() => {});
      return {
        chunks: {
          [Symbol.asyncIterator]() {
            let iterator: AsyncIterator<ShellChunk, void> | null = null;
            return {
              async next() {
                const stream = await start();
                iterator ??= stream.chunks[Symbol.asyncIterator]();
                return iterator.next();
              },
              // 提前 break → 委托内层 iterator.return() 触发 ABORT,否则子进程挂到 timeout
              // (P2-AM)。start() 未 resolve(权限弹窗中)则尚未 spawn,iterator 为 null 无需
              // abort;已 resolve 才有内层 iterator 可关。
              async return(): Promise<IteratorResult<ShellChunk, void>> {
                await iterator?.return?.();
                return { value: undefined, done: true };
              },
            };
          },
        },
        done,
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

function makeEditor(
  pluginId: string,
  store: PermissionStore | null,
  rawEditor: CoEditorApi,
  token?: string,
): CoEditorApi {
  return {
    async openFile(path, opts) {
      try {
        await ensurePerm(pluginId, 'fs', store);
      } catch (err) {
        if (err instanceof PermissionError) {
          return {
            ok: false,
            code: 'PERMISSION_DENIED',
            message: `plugin ${pluginId} lacks 'fs' permission`,
          };
        }
        throw err;
      }

      if (store) {
        // path-scope 校验:openFile 走宿主受信 fs 通道,必须先确认目标在已授
        // scope 内,否则有 'fs' 权限的插件可借此越权打开任意文件。checkPath
        // 现为 PluginFsRaw 必备方法(main 端 plugin-fs:check-path 实装)。
        const scopeOk = await coApi.pluginFsRaw.checkPath(
          token ?? missingPluginFsToken(),
          path,
        );
        if (!scopeOk) {
          return {
            ok: false,
            code: 'PERMISSION_DENIED',
            message: `path '${path}' out of granted scope`,
          };
        }
      }

      return rawEditor.openFile(path, opts);
    },
  };
}

/**
 * per-plugin dataStore:强制用绑定的 pluginId,忽略调用方传入的 id。
 * 防 `app.dataStore.read('别的插件id')` 跨插件读/写他人持久化数据。
 * 注:realm 内恶意代码仍可绕到 coApi.pluginDataRaw 直调,但 main 端已校验
 * pluginId 防路径穿越;此层关闭正常 app.* API 的跨插件访问(纵深防御)。
 */
function makeDataStore(
  pluginId: string,
  raw: PluginDataStore,
): PluginDataStore {
  return {
    read: () => raw.read(pluginId),
    write: (_id, data) => raw.write(pluginId, data),
  };
}

function makeDock(rawDock: CoDockApi): CoDockApi {
  return {
    openPanel(panelId) {
      rawDock.openPanel(panelId);
    },
  };
}

function makeNotifications(
  rawNotifications: CoNotificationsApi,
): CoNotificationsApi {
  return {
    show(opts) {
      rawNotifications.show(opts);
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
  // Omit coApp.mcp/editor raw singletons → 替换为 per-plugin scope wrappers,
  // 其它字段直通。
  const { mcp: registry, editor, dock, notifications, dataStore, ...rest } =
    coApp;
  return {
    ...rest,
    dataStore: makeDataStore(pluginId, dataStore),
    editor: makeEditor(pluginId, store, editor, token),
    dock: makeDock(dock),
    notifications: makeNotifications(notifications),
    fs: makeFs(pluginId, store, token),
    network: makeNetwork(pluginId, store),
    shell: makeShell(pluginId, store),
    clipboard: makeClipboard(pluginId, store),
    permission: makePermission(pluginId, store),
    mcp: makeMcp(pluginId, store, registry),
  };
}
