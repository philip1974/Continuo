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
import type { FileEntry } from '../../electron/shared/fs-entry';
import type { PluginMcpToolSpec } from './registries/PluginMcpRegistry';
import type { PluginDataStore } from './PluginDataStore';
import {
  PermissionError,
  type PermissionDecision,
  type PermissionKey,
  type PermissionStore,
} from './permissions';
import { getCachedClipboard, getCachedFetch } from './sandbox-sweep';
import { coApi } from '@/lib/co-api';
import { joinPath } from '@/lib/path-cross';
import {
  MAX_WRITE_BYTES,
  FS_PATH_MAX,
  isValidGitBlobSha,
  validateScopesShape,
} from '../../electron/shared/fs-limits';
import { utf8BytesExceed } from '../../electron/shared/utf8-byte-length';
import {
  NETWORK_URL_MAX,
  NETWORK_HEADERS_MAX,
  NETWORK_HEADER_KEY_MAX,
  NETWORK_HEADER_VALUE_MAX,
} from '../../electron/shared/network-limits';
import {
  SHELL_PATH_MAX,
  SHELL_ARG_MAX_LEN,
  SHELL_ARGS_MAX_COUNT,
  SHELL_ENV_KEY_MAX,
  SHELL_ENV_VAL_MAX,
  SHELL_ENV_MAX_ENTRIES,
  SHELL_STDIN_MAX,
} from '../../electron/shared/shell-limits';

export function areValidShellArgs(args: readonly unknown[]): boolean {
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > SHELL_ARG_MAX_LEN) {
      return false;
    }
  }
  return true;
}

// 边界(E46,E44/E45 同族):app.shell.exec/execStream 在 renderer wrapper 里先 [...args] 展开并
// structured-clone env/input,主进程 shell.exec(E12)/plugin-shell-stream(E45)虽有上限但已太晚;
// [...args] 对非数组 iterable 还可能无限/超大展开。发 IPC(spread)前按主进程同一上限(shared)预检,
// 超限抛 BAD_INPUT、不 spread、不发 IPC。
function validateShellInput(
  cmd: unknown,
  args: unknown,
  opts?: { cwd?: unknown; env?: unknown; input?: unknown },
): void {
  const bad = (msg: string): never => {
    throw Object.assign(new Error(`[shell] ${msg}`), { code: 'BAD_INPUT' });
  };
  if (typeof cmd !== 'string' || cmd.length === 0 || cmd.length > SHELL_PATH_MAX)
    bad(`invalid cmd (empty or > ${SHELL_PATH_MAX})`);
  // 关键:先确认是数组再(由调用方)spread —— 非数组 iterable 的 [...x] 可能无限/超大展开。
  if (!Array.isArray(args) || args.length > SHELL_ARGS_MAX_COUNT)
    bad(`invalid args (not array or count > ${SHELL_ARGS_MAX_COUNT})`);
  const shellArgs = args as readonly unknown[];
  if (!areValidShellArgs(shellArgs))
    bad(`invalid arg entry (non-string or > ${SHELL_ARG_MAX_LEN})`);
  if (
    opts?.cwd !== undefined &&
    (typeof opts.cwd !== 'string' || opts.cwd.length > SHELL_PATH_MAX)
  )
    bad(`invalid cwd (> ${SHELL_PATH_MAX})`);
  if (
    opts?.input !== undefined &&
    // 边界(E129,E125 同族):stdin 按真实 UTF-8 字节(非 .length=UTF-16 code unit),与主 shell 入口同款。
    (typeof opts.input !== 'string' ||
      utf8BytesExceed(opts.input, SHELL_STDIN_MAX))
  )
    bad(`invalid input (> ${SHELL_STDIN_MAX} 字节)`);
  if (opts?.env !== undefined) {
    const env = opts.env;
    if (typeof env !== 'object' || env === null) bad('invalid env');
    const rec = env as Record<string, unknown>;
    // 边界(E198,E197 同族有界迭代):for...in 单次遍历,边计数边校验,超 SHELL_ENV_MAX_ENTRIES 立即
    // bad() —— 不先 Object.keys 把插件传入的 env 所有 key 全量物化(再判上限=上限失效)。
    let count = 0;
    for (const k in rec) {
      if (!Object.prototype.hasOwnProperty.call(rec, k)) continue;
      count += 1;
      if (count > SHELL_ENV_MAX_ENTRIES)
        bad(`env entries > ${SHELL_ENV_MAX_ENTRIES}`);
      if (k.length > SHELL_ENV_KEY_MAX) bad(`env key > ${SHELL_ENV_KEY_MAX}`);
      const v = rec[k];
      if (typeof v !== 'string' || v.length > SHELL_ENV_VAL_MAX)
        bad(`env value > ${SHELL_ENV_VAL_MAX}`);
    }
  }
}

export function hasGrantedPermissionDecision(
  decisions: readonly PermissionDecision[],
  perm: PermissionKey,
): boolean {
  for (const decision of decisions) {
    if (decision.permission === perm && decision.granted) return true;
  }
  return false;
}

/** 检查 plugin 是否拿到 perm 授权;未授抛 PermissionError. store=null 跳过检查. */
async function ensurePerm(
  pluginId: string,
  perm: PermissionKey,
  store: PermissionStore | null,
): Promise<void> {
  if (!store) return;
  const decisions = await store.get(pluginId);
  const granted = hasGrantedPermissionDecision(decisions, perm);
  if (!granted) throw new PermissionError(perm);
}

function missingPluginFsToken(): never {
  throw new Error('[plugin-fs] no token bound');
}

export function buildPluginListDirEntries(
  path: string,
  entries: readonly Pick<FileEntry, 'name' | 'isDirectory' | 'isSymlink'>[],
): FileEntry[] {
  const parent = path.replace(/[\\/]+$/, '');
  const out = new Array<FileEntry>(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    out[i] = {
      path: joinPath(parent, entry.name),
      name: entry.name,
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
    };
  }
  return out;
}

// 边界(E180,E178 renderer 对偶 / E44 同族):app.fs.* 的路径参数发 coApi.pluginFsRaw.* IPC 前预检。
// 主进程 PathScopeRegistry.check()(E178)已拒超长 target,但正常插件 API 仍会先把超长路径
// structured-clone 进 preload/main → renderer/preload IPC 序列化放大;非 string 还会变 TypeError。
// 复用 FS_PATH_MAX 在发 IPC 前 reject(空字符串放行,交主进程 check() 处理)。
function assertPluginFsPath(path: unknown, label = 'path'): asserts path is string {
  if (typeof path !== 'string' || path.length > FS_PATH_MAX) {
    throw new Error(
      `plugin fs ${label} invalid or too long (max ${FS_PATH_MAX})`,
    );
  }
}

// 边界(E315,E313 同族 / 不转发 raw 外部对象):fs opts 只取契约声明的 boolean 标志,丢弃 JS 插件绕 TS
// 类型塞的额外/超大字段,不让整 opts 进 IPC structured-clone。非对象/缺省 → undefined(等价无 opts);
// 声明字段强制 Boolean(保留 truthy 语义)。各 fs 方法发 IPC 前用之白名单重建 opts。
function pickBoolOpts<K extends string>(
  opts: unknown,
  keys: readonly K[],
): Partial<Record<K, boolean>> | undefined {
  if (!opts || typeof opts !== 'object') return undefined;
  const src = opts as Record<string, unknown>;
  const out: Partial<Record<K, boolean>> = {};
  for (const k of keys) {
    if (src[k] !== undefined) out[k] = Boolean(src[k]);
  }
  return out;
}

function makeFs(
  pluginId: string,
  store: PermissionStore | null,
  token?: string,
): PluginFsApi {
  return {
    requestScope: async (scopes) => {
      await ensurePerm(pluginId, 'fs', store);
      // 边界(E239,E44/E180 pre-IPC 预检族):发 IPC 前用共享 helper 校验 scopes(数量 ≤64 + 每项
      // path/mode)。主进程 plugin-fs:request-scope 也校验,但畸形插件传超大数组/超长路径时,
      // renderer→preload→main 的 structured clone 已先序列化大对象(IPC 放大),主进程才拒绝。前置 reject
      // 不让超量 payload 进 IPC。共享 helper 与主进程同一来源,不漂移。
      const scopesErr = validateScopesShape(scopes);
      if (scopesErr) {
        throw Object.assign(new Error(scopesErr), { code: 'BAD_INPUT' });
      }
      return coApi.pluginFsRaw.requestScope(
        token ?? missingPluginFsToken(),
        scopes,
      );
    },
    readFile: async (path) => {
      await ensurePerm(pluginId, 'fs', store);
      assertPluginFsPath(path); // 边界(E180):发 IPC 前路径长度/type 预检
      return coApi.pluginFsRaw.readFile(token ?? missingPluginFsToken(), path);
    },
    writeFile: async (path, content) => {
      await ensurePerm(pluginId, 'fs', store);
      // 边界(E44,E29 renderer 侧对偶 / E41-E43 同族):发 IPC 前预检 content/path 大小。畸形插件传
      // 超大字符串时,主进程 plugin-fs:write-file 虽有 64MiB 上限(E29),但 ipcRenderer.invoke 的
      // structured clone 已先在 renderer/preload 序列化大对象 → 内存峰值/卡顿。复用 main/renderer 共享
      // 上限(fs-limits)在发 IPC 前 reject,不让超大 payload 进 IPC。
      // 边界(E312,E269 反模式复现):`typeof content === 'string' && 字节检查` 对**非 string** 短路 →
      // 跳过字节上限,非 string(JS 插件绕 TS 类型传 Uint8Array/对象)直接经 structured-clone 进 IPC。
      // content 契约是 string,非 string 即拒(BAD_INPUT);string 再按字节上限。
      if (typeof content !== 'string') {
        throw new Error('plugin write content must be a string');
      }
      // 边界(E125):真实 UTF-8 字节(非 .length=UTF-16 code unit),与主 fs 入口同款。
      if (utf8BytesExceed(content, MAX_WRITE_BYTES)) {
        throw new Error(
          `plugin write content too large (> ${MAX_WRITE_BYTES} 字节)`,
        );
      }
      assertPluginFsPath(path); // 边界(E180,E44 合并):路径长度/type 预检(原 inline 检查收口到 helper)
      return coApi.pluginFsRaw.writeFile(
        token ?? missingPluginFsToken(),
        path,
        content,
      );
    },
    listDir: async (path) => {
      await ensurePerm(pluginId, 'fs', store);
      assertPluginFsPath(path); // 边界(E180)
      const entries = await coApi.pluginFsRaw.listDir(
        token ?? missingPluginFsToken(),
        path,
      );
      return buildPluginListDirEntries(path, entries);
    },
    stat: async (path) => {
      await ensurePerm(pluginId, 'fs', store);
      assertPluginFsPath(path); // 边界(E180)
      return coApi.pluginFsRaw.stat(token ?? missingPluginFsToken(), path);
    },
    lstat: async (path) => {
      await ensurePerm(pluginId, 'fs', store);
      assertPluginFsPath(path); // 边界(E180)
      return coApi.pluginFsRaw.lstat(token ?? missingPluginFsToken(), path);
    },
    realpath: async (path) => {
      await ensurePerm(pluginId, 'fs', store);
      assertPluginFsPath(path); // 边界(E180)
      return coApi.pluginFsRaw.realpath(token ?? missingPluginFsToken(), path);
    },
    mkdir: async (path, opts) => {
      await ensurePerm(pluginId, 'fs', store);
      assertPluginFsPath(path); // 边界(E180)
      return coApi.pluginFsRaw.mkdir(
        token ?? missingPluginFsToken(),
        path,
        pickBoolOpts(opts, ['recursive']), // 边界(E315):白名单 opts
      );
    },
    rename: async (src, dst) => {
      await ensurePerm(pluginId, 'fs', store);
      assertPluginFsPath(src, 'src'); // 边界(E180)
      assertPluginFsPath(dst, 'dst');
      return coApi.pluginFsRaw.rename(token ?? missingPluginFsToken(), src, dst);
    },
    rm: async (path, opts) => {
      await ensurePerm(pluginId, 'fs', store);
      assertPluginFsPath(path); // 边界(E180)
      return coApi.pluginFsRaw.rm(
        token ?? missingPluginFsToken(),
        path,
        pickBoolOpts(opts, ['recursive', 'force']), // 边界(E315):白名单 opts
      );
    },
    cp: async (src, dst, opts) => {
      await ensurePerm(pluginId, 'fs', store);
      assertPluginFsPath(src, 'src'); // 边界(E180)
      assertPluginFsPath(dst, 'dst');
      return coApi.pluginFsRaw.cp(
        token ?? missingPluginFsToken(),
        src,
        dst,
        pickBoolOpts(opts, ['recursive']), // 边界(E315):白名单 opts
      );
    },
    readGitBlob: async (repoDir, sha) => {
      await ensurePerm(pluginId, 'fs', store);
      assertPluginFsPath(repoDir, 'repoDir'); // 边界(E180)
      // 边界(E314,E63 renderer 对偶 / pre-IPC 预检):sha 发 IPC 前校验 hex 形态 —— 此前只校验 repoDir,
      // 超长/非 hex sha 经 structured-clone 进 main 才被 GIT_BLOB_SHA_RE 拒(IPC 放大)。共享 isValidGitBlobSha。
      if (!isValidGitBlobSha(sha)) {
        throw Object.assign(
          new Error('plugin readGitBlob sha must be 4-64 hex chars'),
          { code: 'BAD_INPUT' },
        );
      }
      return coApi.pluginFsRaw.readGitBlob(
        token ?? missingPluginFsToken(),
        repoDir,
        sha,
      );
    },
    atomicReplaceWithinScope: async (staging, final, opts) => {
      await ensurePerm(pluginId, 'fs', store);
      assertPluginFsPath(staging, 'staging'); // 边界(E180)
      assertPluginFsPath(final, 'final');
      return coApi.pluginFsRaw.atomicReplaceWithinScope(
        token ?? missingPluginFsToken(),
        staging,
        final,
        pickBoolOpts(opts, ['overwrite']), // 边界(E315):白名单 opts
      );
    },
    userHome: async () => {
      // No fs permission required - only returns home path string (not fs access).
      return coApi.pluginFsRaw.userHome(token ?? missingPluginFsToken());
    },
  };
}

// 边界(E264,E46/E180 pre-call 预检族):app.network.fetch 在调 raw fetch 前校验 URL 与 headers。
// network 此前是唯一无输入边界闸的能力(fs/shell 等都有)。URL/headers 由 fetch 同步解析,超长 URL /
// 海量·超长 headers 会让(与插件共享的)renderer 网络栈解析放大。body 不在此 cap(浏览器流式发送、
// 非 renderer 同步物化;给 body 限大小是上传策略决策,留作单独议题)。超限抛 BAD_INPUT、不调 fetch。
function validateNetworkInput(url: unknown, init?: unknown): void {
  const bad = (msg: string): never => {
    throw Object.assign(new Error(`[network] ${msg}`), { code: 'BAD_INPUT' });
  };
  if (typeof url !== 'string' || url.length === 0 || url.length > NETWORK_URL_MAX)
    bad(`invalid url (empty or > ${NETWORK_URL_MAX})`);
  if (init === undefined || init === null) return;
  if (typeof init !== 'object') bad('invalid init');
  const headers = (init as { headers?: unknown }).headers;
  if (headers === undefined || headers === null) return;

  // 归一化为 [key,value][] 并边收集边 cap 条数(不先全量物化超量 headers);Headers 实例 forEach
  // 无法 early-break,但其条数由插件自身构造、已物化,push 后统一判上限。
  const entries: Array<[unknown, unknown]> = [];
  const pushEntry = (k: unknown, v: unknown): void => {
    entries.push([k, v]);
    if (entries.length > NETWORK_HEADERS_MAX) bad(`headers > ${NETWORK_HEADERS_MAX}`);
  };
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (!Array.isArray(pair)) bad('invalid header entry (not a pair)');
      pushEntry((pair as unknown[])[0], (pair as unknown[])[1]);
    }
  } else if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((v, k) => pushEntry(k, v));
    if (entries.length > NETWORK_HEADERS_MAX) bad(`headers > ${NETWORK_HEADERS_MAX}`);
  } else if (typeof headers === 'object') {
    for (const k in headers as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
      pushEntry(k, (headers as Record<string, unknown>)[k]);
    }
  } else {
    bad('invalid headers');
  }
  for (const [k, v] of entries) {
    // 边界(E269,E264 自引入缺口):**要求** key/value 都是 string 再校验长度。此前 `typeof x==='string'
    // && len>MAX` 让**非 string** key/value 直接通过预检,随后 fetch/Headers 隐式 String()(如
    // {toString(){return huge}})在 raw fetch 边界再触发超长转换 → 削弱"fetch 前校验"契约。非 string 直接拒。
    if (typeof k !== 'string' || k.length > NETWORK_HEADER_KEY_MAX)
      bad(`invalid header key (non-string or > ${NETWORK_HEADER_KEY_MAX})`);
    if (typeof v !== 'string' || v.length > NETWORK_HEADER_VALUE_MAX)
      bad(`invalid header value (non-string or > ${NETWORK_HEADER_VALUE_MAX})`);
  }
}

function makeNetwork(
  pluginId: string,
  store: PermissionStore | null,
): PluginNetworkApi {
  return {
    async fetch(url, init) {
      await ensurePerm(pluginId, 'network', store);
      validateNetworkInput(url, init); // 边界(E264):发 raw fetch 前校验 URL/headers
      // 用 module 顶部 cached raw fetch,sandboxSweep 后全局 fetch
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
      validateShellInput(cmd, args, opts); // 边界(E46):spread/发 IPC 前预检
      const r = await coApi.shell.exec({
        cmd,
        args: [...args],
        cwd: opts?.cwd,
        env: opts?.env,
        timeoutMs: opts?.timeoutMs,
        input: opts?.input,
        maxOutputBytes: opts?.maxOutputBytes,
      });
      // i18n(I13,让 I11 的 by-code 本地化对 shell.exec 生效):保留 r.code 到 Error.code,
      // 否则冒泡到 runContributedAction 时拿不到 code,BAD_INPUT 等会在 zh/ko toast 显英文
      // raw。带 code → runContributedAction 经 localizeErrorByCode 按 catalog 本地化。
      if (!r.ok) {
        throw Object.assign(
          new Error(`[shell.exec] ${r.code}: ${r.message}`),
          { code: r.code },
        );
      }
      return r.data;
    },
    execStream(cmd, args, opts) {
      type StreamHandle = ReturnType<
        typeof coApi.pluginShellStreamRaw.execStream
      >;
      let raw: StreamHandle | null = null;
      let startPromise: Promise<StreamHandle> | null = null;
      // race(R94):消费者在权限等待期间提前 break/return 的取消标志。execStream 是急切启动
      // (下方 const done = start()),start() 的 ensurePerm 可能挂在权限弹窗;此时 chunks.return()
      // 因内层 iterator 尚为 null 而跳过 abort。若不记取消,权限 resolve 后 start() 仍会
      // execStreamRaw **真的 spawn 子进程** —— 已取消消费的命令迟到执行,无人读 chunks,子进程挂到
      // timeout = 资源泄漏 + 意外命令执行。return() 置 cancelled;start() 在 ensurePerm 之后、真正
      // spawn 之前复查,已取消则返回一个立即终止的合成 stream(不 spawn,done 收敛)。
      let cancelled = false;
      const cancelledStream: StreamHandle = {
        chunks: {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                Promise.resolve({ value: undefined, done: true as const }),
            };
          },
        },
        done: Promise.resolve({ exitCode: null, signal: null }),
      };
      const start = async (): Promise<StreamHandle> => {
        if (raw) return raw;
        if (!startPromise) {
          startPromise = (async () => {
            await ensurePerm(pluginId, 'shell', store);
            // race(R94):权限等待期间已被消费者取消 → 不 spawn,返回合成终止 stream。
            if (cancelled) return cancelledStream;
            // 边界(E46):发 IPC(structured-clone args/opts)前预检,超限抛 BAD_INPUT(经
            // startPromise reject 由 done/chunks 错误路径上抛,与 ensurePerm 异常同款语义)。
            validateShellInput(cmd, args, opts);
            // 边界(E313,E46/E312 同族 / 不转发 raw 外部对象):opts 是插件提供对象,JS 插件可绕 TS 类型
            // 塞额外/超大字段;此前整 opts 直接进 IPC structured-clone(放大)。只取契约声明字段
            //({timeoutMs, cwd}),丢弃未知额外字段后再发 IPC(validateShellInput 已先校验 cwd/env/input)。
            const safeOpts =
              opts === undefined
                ? undefined
                : { cwd: opts.cwd, timeoutMs: opts.timeoutMs };
            raw = coApi.pluginShellStreamRaw.execStream(cmd, args, safeOpts);
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
                // race(R94):标记取消 —— 若 start() 仍在 ensurePerm(权限弹窗中,iterator 尚为 null),
                // 权限 resolve 后据此不 spawn 子进程,避免已取消命令迟到执行 + 子进程泄漏。
                cancelled = true;
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

// 边界(E181,fs/shell/notifications 兄弟入口同款):clipboard.writeText 的 UTF-8 字节上限。clipboard
// 文本通常 KB 级,16MiB 远超任何真实复制场景,只挡畸形/恶意超大输入(防 renderer/系统 clipboard API
// 卡顿/内存峰值)。
const CLIPBOARD_TEXT_MAX_BYTES = 16 * 1024 * 1024;

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
      // 边界(E181):发原生 clipboard 前校验类型 + UTF-8 字节上限。畸形/恶意插件传非 string 或超大
      // 字符串 → renderer/系统 clipboard API 卡顿/内存峰值/异常路径。非法抛 BAD_INPUT(同 shell/fs 入口)。
      if (typeof text !== 'string') {
        throw Object.assign(
          new Error('[clipboard] writeText: text must be a string'),
          { code: 'BAD_INPUT' },
        );
      }
      if (utf8BytesExceed(text, CLIPBOARD_TEXT_MAX_BYTES)) {
        throw Object.assign(
          new Error(
            `[clipboard] writeText: text too large (> ${CLIPBOARD_TEXT_MAX_BYTES} 字节)`,
          ),
          { code: 'BAD_INPUT' },
        );
      }
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

      // 边界(E182,E180 同族):path 类型/长度前置闸(发 checkPath IPC 前),与 app.fs.* 的
      // assertPluginFsPath 一致。畸形/超长 path 否则先 structured-clone 进主进程才被 checkPath 拒。
      // openFile 契约返回结果对象(非抛),故非法返回 {ok:false, INVALID_PATH}(不复用会 throw 的 helper)。
      if (
        typeof path !== 'string' ||
        path.length === 0 ||
        path.length > FS_PATH_MAX
      ) {
        return {
          ok: false,
          code: 'INVALID_PATH',
          message: `openFile path invalid or too long (max ${FS_PATH_MAX})`,
        };
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
      return hasGrantedPermissionDecision(decisions, perm);
    },
    async granted() {
      if (!store) return [];
      const decisions = await store.get(pluginId);
      const out = new Array<PermissionKey>(decisions.length);
      let outCount = 0;
      for (const d of decisions) {
        if (d.granted) out[outCount++] = d.permission;
      }
      out.length = outCount;
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
