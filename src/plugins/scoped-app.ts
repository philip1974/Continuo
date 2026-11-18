// ScopedApp(M-Plugin v5 Phase 1-3):per-plugin 包装的 CoApp。
//
// 解决"app 是单例 plugin 无法分辨调用方"难题:每次 activateEntry 都
// new 一个 ScopedApp,fs/network/clipboard/permission 知道自己服务哪个
// pluginId,各方法调 store.get(pluginId) 检查授权。
//
// Phase 3:fs/network/clipboard 各方法接入 permission.check,未授抛
// PermissionError,plugin 须 try/catch 优雅降级。
// store=null(向后兼容/测试)时跳过检查直接转发,permission.check 一律 true。
//
// 终审 P1(停用即吊销):PluginManager 在插件实例离开运行态时先 revoke() 再调 onunload。吊销后有外部副作用的
// 能力(shell / network / fs 写与 requestScope / clipboard / mcp 注册与调用 / notifications / dock / editor.openFile)
// 在 renderer 源头拒绝、不发 IPC —— 延迟回调或超时后仍在跑的 onunload 不能再起进程 / 发请求。
// 不阻断:fs 读、dataStore(插件自有数据,onunload 常用 saveData)、permission 查询、userHome。
// (卸载后的 saveData 由主进程拒绝:只写已安装插件的目录,见 src/__tests__/plugin-data-uninstall-zombie/。)
// 贡献点注册表 / events:吊销后 register / on / subscribe 拒绝,吊销前经 scoped app 直接注册的贡献与订阅在
// revoke() 时统一注销(见 trackContributions);commands.execute / events.emit / events.clear 有外部副作用
//(执行宿主命令可开窗口 / 终端,emit 触发他人监听),同样拒绝;只放行只读查询与 events.off。
// 所有权:register 不能覆盖非本插件注册的 key(见 contributionOwners);events.clear 只清本插件自己的订阅。
// 经 app.mcp.register 注册的工具同样在 revoke() 时注销(插件未保存 Disposable 也不残留)。
// 只读查询结果是浅拷贝,其中回调包吊销检查(缓存 commands.get(..).fn 停用后调用同样被拒)。
// 见 src/__tests__/plugin-capability-revoke/。

import type {
  CoApp,
  CoDockApi,
  Disposable,
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
import { isSpecObject } from './registries/spec-guard';
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
import { codedError } from '../../electron/shared/error-message';
import {
  NETWORK_URL_MAX,
  NETWORK_HEADERS_MAX,
  NETWORK_HEADER_KEY_MAX,
  NETWORK_HEADER_VALUE_MAX,
} from '../../electron/shared/network-limits';
import {
  SHELL_ENV_KEY_MAX,
  SHELL_ENV_VAL_MAX,
  SHELL_ENV_MAX_ENTRIES,
  SHELL_STDIN_MAX,
  shellCommandShapeError,
} from '../../electron/shared/shell-limits';

const EMPTY_SHELL_ARGS: readonly string[] = [];

function copyShellArgs(args: readonly string[]): readonly string[] {
  if (args.length === 0) return EMPTY_SHELL_ARGS;
  const copied = new Array<string>(args.length);
  for (let i = 0; i < args.length; i++) copied[i] = args[i]!;
  return copied;
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
    throw codedError('BAD_INPUT', `[shell] ${msg}`);
  };
  // cmd / args / cwd 三段与 main 入口共用 shellCommandShapeError(先确认 args 是数组再由调用方 spread)。
  const shapeError = shellCommandShapeError(cmd, args, opts?.cwd);
  if (shapeError !== null) bad(shapeError);
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

/** scoped app 的吊销状态(per-instance,由 createScopedAppController 持有). */
interface ScopedLifecycle {
  revoked: boolean;
  /** 在途 network.fetch 的中止器(revoke 时全部 abort,请求结束即移除). */
  inflightFetches: Set<AbortController>;
}

function revokedMessage(pluginId: string, capability: string): string {
  return `plugin ${pluginId} has been deactivated; '${capability}' revoked`;
}

/** 已吊销 → 抛 PermissionError(权限门控能力)。 */
function assertLive(pluginId: string, perm: PermissionKey, life: ScopedLifecycle): void {
  if (life.revoked) throw new PermissionError(perm, revokedMessage(pluginId, perm));
}

/** 已吊销 → 抛 PERMISSION_DENIED(无权限项的 UI 副作用能力:notifications / dock)。 */
function assertLiveUi(pluginId: string, capability: string, life: ScopedLifecycle): void {
  if (life.revoked) throw codedError('PERMISSION_DENIED', revokedMessage(pluginId, capability));
}

/**
 * 检查 plugin 是否拿到 perm 授权;未授抛 PermissionError. store=null 跳过授权检查.
 * 传入 life 时 await 前后各查一次吊销状态:授权读取(可能挂在 IPC)期间被吊销,返回后也不放行 ——
 * 调用方在本函数返回后同步发 IPC,即「吊销之后不再发出任何副作用请求」。
 */
async function ensurePerm(
  pluginId: string,
  perm: PermissionKey,
  store: PermissionStore | null,
  life?: ScopedLifecycle,
): Promise<void> {
  if (life) assertLive(pluginId, perm, life);
  if (store) {
    const decisions = await store.get(pluginId);
    const granted = hasGrantedPermissionDecision(decisions, perm);
    if (!granted) throw new PermissionError(perm);
  }
  if (life) assertLive(pluginId, perm, life);
}

function missingPluginFsToken(): never {
  throw new Error('[plugin-fs] no token bound');
}

const EMPTY_PLUGIN_LIST_DIR_ENTRIES: FileEntry[] = [];

export function buildPluginListDirEntries(
  path: string,
  entries: readonly Pick<FileEntry, 'name' | 'isDirectory' | 'isSymlink'>[],
): FileEntry[] {
  if (entries.length === 0) return EMPTY_PLUGIN_LIST_DIR_ENTRIES;
  const parent = path;
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
    throw codedError(
      'BAD_INPUT',
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
  life: ScopedLifecycle,
  token?: string,
): PluginFsApi {
  // 吊销只拦写类 / 扩权类(有外部副作用);读类不拦(onunload 收尾可读,停用随即回收 fs token)。
  return {
    requestScope: async (scopes) => {
      await ensurePerm(pluginId, 'fs', store, life);
      // 边界(E239,E44/E180 pre-IPC 预检族):发 IPC 前用共享 helper 校验 scopes(数量 ≤64 + 每项
      // path/mode)。主进程 plugin-fs:request-scope 也校验,但畸形插件传超大数组/超长路径时,
      // renderer→preload→main 的 structured clone 已先序列化大对象(IPC 放大),主进程才拒绝。前置 reject
      // 不让超量 payload 进 IPC。共享 helper 与主进程同一来源,不漂移。
      const scopesErr = validateScopesShape(scopes);
      if (scopesErr) {
        throw codedError('BAD_INPUT', scopesErr);
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
      await ensurePerm(pluginId, 'fs', store, life);
      // 边界(E44,E29 renderer 侧对偶 / E41-E43 同族):发 IPC 前预检 content/path 大小。畸形插件传
      // 超大字符串时,主进程 plugin-fs:write-file 虽有 64MiB 上限(E29),但 ipcRenderer.invoke 的
      // structured clone 已先在 renderer/preload 序列化大对象 → 内存峰值/卡顿。复用 main/renderer 共享
      // 上限(fs-limits)在发 IPC 前 reject,不让超大 payload 进 IPC。
      // 边界(E312,E269 反模式复现):`typeof content === 'string' && 字节检查` 对**非 string** 短路 →
      // 跳过字节上限,非 string(JS 插件绕 TS 类型传 Uint8Array/对象)直接经 structured-clone 进 IPC。
      // content 契约是 string,非 string 即拒(BAD_INPUT);string 再按字节上限。
      if (typeof content !== 'string') {
        throw codedError('BAD_INPUT', 'plugin write content must be a string');
      }
      // 边界(E125):真实 UTF-8 字节(非 .length=UTF-16 code unit),与主 fs 入口同款。
      if (utf8BytesExceed(content, MAX_WRITE_BYTES)) {
        throw codedError(
          'BAD_INPUT',
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
      await ensurePerm(pluginId, 'fs', store, life);
      assertPluginFsPath(path); // 边界(E180)
      return coApi.pluginFsRaw.mkdir(
        token ?? missingPluginFsToken(),
        path,
        pickBoolOpts(opts, ['recursive']), // 边界(E315):白名单 opts
      );
    },
    rename: async (src, dst) => {
      await ensurePerm(pluginId, 'fs', store, life);
      assertPluginFsPath(src, 'src'); // 边界(E180)
      assertPluginFsPath(dst, 'dst');
      return coApi.pluginFsRaw.rename(token ?? missingPluginFsToken(), src, dst);
    },
    rm: async (path, opts) => {
      await ensurePerm(pluginId, 'fs', store, life);
      assertPluginFsPath(path); // 边界(E180)
      return coApi.pluginFsRaw.rm(
        token ?? missingPluginFsToken(),
        path,
        pickBoolOpts(opts, ['recursive', 'force']), // 边界(E315):白名单 opts
      );
    },
    cp: async (src, dst, opts) => {
      await ensurePerm(pluginId, 'fs', store, life);
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
      // 超长/非 hex sha 经 structured-clone 进 main 才被 isValidGitBlobSha 拒(IPC 放大)。共享 isValidGitBlobSha。
      if (!isValidGitBlobSha(sha)) {
        throw codedError('BAD_INPUT', 'plugin readGitBlob sha must be a full 40- or 64-char hex sha');
      }
      return coApi.pluginFsRaw.readGitBlob(
        token ?? missingPluginFsToken(),
        repoDir,
        sha.toLowerCase(), // 与主进程入口一致:统一小写(git 内部按小写找对象)
      );
    },
    atomicReplaceWithinScope: async (staging, final, opts) => {
      await ensurePerm(pluginId, 'fs', store, life);
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
//
// 安全(scheme):只放行**绝对 https:** URL,返回解析后的 href 供实际请求使用(校验与请求同一个值)。
// 打包版页面源是 file://,CSP connect-src 管不到 file:,原生 fetch 对 `file:///…` 以及相对路径(按页面
// base 解析成 file:)直接返回本地文件内容 —— 只授了 network 的插件即可读任意文件再 https 外传,整体旁路
// fs 权限与主进程 path-scope。不带 base 解析:相对 / 协议相对 URL 一律拒。http 不放行(与生产 CSP
// connect-src 一致)。重定向无需额外处理:Chromium 拒绝 http(s) → file: 的重定向(Electron 45 实测)。
function validateNetworkInput(url: unknown, init?: unknown): string {
  const bad = (msg: string): never => {
    throw codedError('BAD_INPUT', `[network] ${msg}`);
  };
  if (typeof url !== 'string' || url.length === 0 || url.length > NETWORK_URL_MAX)
    return bad(`invalid url (empty or > ${NETWORK_URL_MAX})`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return bad('invalid url (must be an absolute https: URL)');
  }
  if (parsed.protocol !== 'https:') bad('invalid url (only https: is allowed)');
  const href = parsed.href;
  if (init === undefined || init === null) return href;
  if (typeof init !== 'object') bad('invalid init');
  const headers = (init as { headers?: unknown }).headers;
  if (headers === undefined || headers === null) return href;

  let headerCount = 0;
  const validateHeaderEntry = (k: unknown, v: unknown): void => {
    headerCount += 1;
    if (headerCount > NETWORK_HEADERS_MAX)
      bad(`headers > ${NETWORK_HEADERS_MAX}`);
    // 边界(E269,E264 自引入缺口):**要求** key/value 都是 string 再校验长度。此前 `typeof x==='string'
    // && len>MAX` 让**非 string** key/value 直接通过预检,随后 fetch/Headers 隐式 String()(如
    // {toString(){return huge}})在 raw fetch 边界再触发超长转换 → 削弱"fetch 前校验"契约。非 string 直接拒。
    if (typeof k !== 'string' || k.length > NETWORK_HEADER_KEY_MAX)
      bad(`invalid header key (non-string or > ${NETWORK_HEADER_KEY_MAX})`);
    if (typeof v !== 'string' || v.length > NETWORK_HEADER_VALUE_MAX)
      bad(`invalid header value (non-string or > ${NETWORK_HEADER_VALUE_MAX})`);
  };
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (!Array.isArray(pair)) bad('invalid header entry (not a pair)');
      validateHeaderEntry((pair as unknown[])[0], (pair as unknown[])[1]);
    }
  } else if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((v, k) => validateHeaderEntry(k, v));
  } else if (typeof headers === 'object') {
    for (const k in headers as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
      validateHeaderEntry(k, (headers as Record<string, unknown>)[k]);
    }
  } else {
    bad('invalid headers');
  }
  return href;
}

function makeNetwork(
  pluginId: string,
  store: PermissionStore | null,
  life: ScopedLifecycle,
): PluginNetworkApi {
  return {
    async fetch(url, init) {
      await ensurePerm(pluginId, 'network', store, life);
      const href = validateNetworkInput(url, init); // 边界(E264)+ 安全:校验 URL/headers,只放行 https
      // 停用即中止(终审):每次请求挂本实例的 AbortController,revoke() 时 abort 全部在途请求。
      // 调用方自带 signal 时用 AbortSignal.any 合并:成功后响应体仍在读取,调用方 abort 须能照常中止(同原生
      // fetch 语义);且源 signal 对合并 signal 只持弱引用,长期复用同一调用方 signal 轮询不会堆积监听(终审)。
      const ctl = new AbortController();
      const callerSignal = init?.signal ?? undefined;
      const signal = callerSignal ? AbortSignal.any([callerSignal, ctl.signal]) : ctl.signal;
      life.inflightFetches.add(ctl);
      try {
        // 用 module 顶部 cached raw fetch,sandboxSweep 后全局 fetch
        // 已涂掉但本闭包仍能调
        return await getCachedFetch()(href, { ...init, signal });
      } finally {
        life.inflightFetches.delete(ctl);
      }
    },
  };
}

// 可维护性 M7:shell stream chunk(与 preload 镜像)。迭代器 yield 此类型,结束值为 void
// (`{ value: undefined, done: true }`),用类型表达迭代器结束语义,免 `undefined as never`。
type ShellChunk = { stream: 'stdout' | 'stderr'; chunk: Uint8Array };

function makeShell(
  pluginId: string,
  store: PermissionStore | null,
  life: ScopedLifecycle,
): PluginShellApi {
  return {
    async exec(cmd, args, opts) {
      await ensurePerm(pluginId, 'shell', store, life);
      validateShellInput(cmd, args, opts); // 边界(E46):spread/发 IPC 前预检
      const r = await coApi.shell.exec({
        cmd,
        args: copyShellArgs(args),
        cwd: opts?.cwd,
        env: opts?.env,
        timeoutMs: opts?.timeoutMs,
        input: opts?.input,
        maxOutputBytes: opts?.maxOutputBytes,
        // 终审 P1:main 按 (窗口, 插件) 登记进程,插件停用/卸载时终止(不作授权依据)。
        pluginId,
      });
      // i18n(I13,让 I11 的 by-code 本地化对 shell.exec 生效):保留 r.code 到 Error.code,
      // 否则冒泡到 runContributedAction 时拿不到 code,BAD_INPUT 等会在 zh/ko toast 显英文
      // raw。带 code → runContributedAction 经 localizeErrorByCode 按 catalog 本地化。
      if (!r.ok) {
        throw codedError(r.code, `[shell.exec] ${r.code}: ${r.message}`);
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
            await ensurePerm(pluginId, 'shell', store, life);
            // race(R94):权限等待期间已被消费者取消 → 不 spawn,返回合成终止 stream。
            if (cancelled) return cancelledStream;
            // 边界(E46):发 IPC(structured-clone args/opts)前预检,超限抛 BAD_INPUT(经
            // startPromise reject 由 done/chunks 错误路径上抛,与 ensurePerm 异常同款语义)。
            validateShellInput(cmd, args, opts);
            // 边界(E313,E46/E312 同族 / 不转发 raw 外部对象):opts 是插件提供对象,JS 插件可绕 TS 类型
            // 塞额外/超大字段;此前整 opts 直接进 IPC structured-clone(放大)。只取契约声明字段
            //({timeoutMs, cwd}),丢弃未知额外字段后再发 IPC(validateShellInput 已先校验 cwd/env/input)。
            // 终审 P1:带上插件 id,main 据此在插件停用/卸载时终止该流(不作授权依据)。
            const safeOpts =
              opts === undefined
                ? { pluginId }
                : { cwd: opts.cwd, timeoutMs: opts.timeoutMs, pluginId };
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
  life: ScopedLifecycle,
): PluginClipboardApi {
  // 吊销后读写都拦:读剪贴板是用户隐私数据,停用后的代码没有正当用途。
  return {
    async readText() {
      await ensurePerm(pluginId, 'clipboard', store, life);
      return getCachedClipboard().readText();
    },
    async writeText(text) {
      await ensurePerm(pluginId, 'clipboard', store, life);
      // 边界(E181):发原生 clipboard 前校验类型 + UTF-8 字节上限。畸形/恶意插件传非 string 或超大
      // 字符串 → renderer/系统 clipboard API 卡顿/内存峰值/异常路径。非法抛 BAD_INPUT(同 shell/fs 入口)。
      if (typeof text !== 'string') {
        throw codedError('BAD_INPUT', '[clipboard] writeText: text must be a string');
      }
      if (utf8BytesExceed(text, CLIPBOARD_TEXT_MAX_BYTES)) {
        throw codedError('BAD_INPUT', `[clipboard] writeText: text too large (> ${CLIPBOARD_TEXT_MAX_BYTES} 字节)`,);
      }
      return getCachedClipboard().writeText(text);
    },
  };
}

/**
 * 终审 P1(撤销 mcp-tools 后已注册工具仍可调用):权限不只在 register 时查 ——
 * - 兜底:把 authorize 交给 registry,每次调用分发到 run 前重查(吊销 / 撤销授权 → PERMISSION_DENIED);
 * - 列表准确:记录本实例注册的工具,recheck() 发现已无 mcp-tools 授权时全部注销(走原 Disposable,
 *   main 侧 stub 同步移除;之后插件停用再 dispose 是幂等 no-op)。
 */
function makeMcp(
  pluginId: string,
  store: PermissionStore | null,
  registry: CoApp['mcp'],
  life: ScopedLifecycle,
): { api: PluginMcpApi; recheck: () => Promise<void>; disposeAll: () => void } {
  const tools = new Set<Disposable>();
  const authorize = (): Promise<void> => ensurePerm(pluginId, 'mcp-tools', store, life);
  const api: PluginMcpApi = {
    async register<I, O>(spec: PluginMcpToolSpec<I, O>) {
      await authorize();
      const inner = await registry.register(spec, pluginId, authorize);
      const tracked: Disposable = {
        dispose: () => {
          tools.delete(tracked);
          inner.dispose();
        },
      };
      // 注册 IPC 在途期间被吊销 → 立即撤回,不留下停用实例的工具。
      if (life.revoked) {
        tracked.dispose();
        assertLive(pluginId, 'mcp-tools', life);
      }
      tools.add(tracked);
      return tracked;
    },
  };
  // 经原 Disposable 注销本实例全部工具(main stub 同步移除);单个抛错不传染。
  const disposeAll = (): void => {
    for (const t of [...tools]) {
      try {
        t.dispose();
      } catch (err) {
        console.warn(`[scoped-app] ${pluginId} dispose mcp tool failed`, err);
      }
    }
  };
  const recheck = async (): Promise<void> => {
    if (tools.size === 0) return;
    try {
      await ensurePerm(pluginId, 'mcp-tools', store);
    } catch (err) {
      if (!(err instanceof PermissionError)) throw err;
      disposeAll();
    }
  };
  return { api, recheck, disposeAll };
}

function makeEditor(
  pluginId: string,
  store: PermissionStore | null,
  rawEditor: CoEditorApi,
  life: ScopedLifecycle,
  token?: string,
): CoEditorApi {
  const revokedResult = {
    ok: false,
    code: 'PERMISSION_DENIED',
    message: revokedMessage(pluginId, 'editor.openFile'),
  } as const;
  return {
    async openFile(path, opts) {
      // 终审 P1:吊销后不再打开编辑器(UI 副作用);契约返回结果对象(非抛)。
      if (life.revoked) return revokedResult;
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

      // 授权 / scope 检查 await 期间被吊销 → 同样不打开。
      if (life.revoked) return revokedResult;
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

function makeDock(pluginId: string, rawDock: CoDockApi, life: ScopedLifecycle): CoDockApi {
  return {
    openPanel(panelId) {
      assertLiveUi(pluginId, 'dock.openPanel', life);
      rawDock.openPanel(panelId);
    },
  };
}

function makeNotifications(
  pluginId: string,
  rawNotifications: CoNotificationsApi,
  life: ScopedLifecycle,
): CoNotificationsApi {
  return {
    show(opts) {
      assertLiveUi(pluginId, 'notifications.show', life);
      rawNotifications.show(opts);
    },
  };
}

/** keyed 注册表对插件公开的共同成员(各表特有的 list / execute / getBySide / getByCategory 在构造处追加)。 */
const KEYED_MEMBERS = ['register', 'get', 'getAll', 'subscribe'] as const;
/** 注册 / 订阅类方法名:返回 Disposable(register / on)或退订函数(subscribe)。 */
const CONTRIBUTION_METHODS: ReadonlySet<string> = new Set(['register', 'on', 'subscribe']);
/**
 * 吊销后仍放行的成员:只读查询 + events.off(只能移除调用方持有引用的 listener,即自身订阅)。
 * 白名单 —— 其余成员(commands.execute / events.emit / events.clear 及未来新增方法)吊销后一律拒绝。
 */
const PASSTHROUGH_METHODS: ReadonlySet<string> = new Set([
  'get',
  'getAll',
  'list',
  'getBySide',
  'getByCategory',
  'off',
]);
/** 返回 Promise 的成员:吊销后以 reject 拒绝(契约是异步),其余同步抛。 */
const ASYNC_METHODS: ReadonlySet<string> = new Set(['execute']);

/**
 * 安全(注册表内部经 scoped app 可达):插件拿到的每个贡献点命名空间是**只含 SDK 公开方法的冻结外观**,不是注册表
 * 实例,也不是它的 Proxy。此前是 Proxy:非函数属性原样返回(`app.commands.items` 就是内部 Map 本体),白名单之外的
 * 方法直通(`registerKeyed` 绕过校验 / 冻结快照 / 所有权,且不受吊销约束),原型也可达
 * (`Object.getPrototypeOf(app.commands).register.call(…)`)—— 零权限插件即可覆盖宿主命令、替换权限管理页。
 * 外观的方法是闭包,不读 this;公开方法清单由调用方按 types.ts 的 Plugin*Api 传入(见 createScopedAppController)。
 *
 * 终审 P1(停用后仍可经原始注册表注册):各方法的语义 ——
 * - register / on / subscribe:已吊销 → 抛 PERMISSION_DENIED、不入表;否则照常注册,并把退订句柄记入 owned,
 *   revoke() 时统一注销(插件绕过 Plugin.register 直接注册的贡献,停用时同样被清理)。返回的句柄幂等,
 *   先被插件 / Plugin 自行 dispose 则从 owned 移除。
 * - 只读查询与 events.off(PASSTHROUGH_METHODS):直通,但结果中的回调包吊销检查(见 guardResult)。
 * - 其余成员(commands.execute / events.emit / events.clear ...)有外部副作用:已吊销 → 拒绝
 *   (execute 返回 reject 的 Promise,其余同步抛 PERMISSION_DENIED),未吊销照常直通。
 */
/**
 * 安全(零权限插件覆盖宿主贡献点):keyed 注册表同 key「后注册赢」,插件注册 settingTab `core.plugins`、panel
 * `settings` / `terminal`、command `terminal.new` 即可替换权限管理页、接管面板、劫持内置命令与快捷键。
 * 这里按注册表里**当前存活的 spec 对象**记录它由谁注册(弱引用:条目被注销 / 被宿主覆盖后记录自然失效);
 * 没有记录 = 宿主自身代码直接在注册表上注册的。scoped app 的 register 遇到已存在且所有者不是自己的 key 即拒绝。
 * 注册表本身(宿主代码直接调用)的「后注册赢」语义不变。
 */
const contributionOwners = new WeakMap<object, string>();

/**
 * 该贡献(注册表里存活的 spec 对象)是否按第三方插件对待。只有内置插件(宿主自建、不带 token 的 scoped app)
 * 注册的 → false;第三方插件注册的、以及**查不到所有者记录的** → true(fail-closed:所有者不明就只给最小接口面)。
 * 宿主把自己的内部对象交给贡献回调前用它决定要不要收窄(如 dock 面板 factory 的 props)。
 * 宿主 / 内置面板全部经 bootCorePlugins 的 scoped app 注册,都有 `core:` 所有者记录。
 */
export function isThirdPartyContribution(spec: object): boolean {
  return contributionOwners.get(spec)?.startsWith('core:') !== true;
}

/**
 * 贡献 spec 的冻结快照(见 trackContributions 的 TOCTOU 说明)。顶层浅拷贝;嵌套的**数据**字段要深拷贝冻结,否则
 * 入表的仍是插件手里的引用:注册期校验通过后再改(把 label 换成对象 / 超长串、往数组里追加选项)即绕过校验。
 * 各贡献点 spec 里数组 / 对象形态的数据字段目前只有 settingItems 的 `enum`(选项是只含字符串字段的平对象);
 * 其余非函数字段都是原始值或 ReactNode(icon:不校验内容,不拷贝)。非数组的 enum 原样留给注册表校验报错。
 */
// 远高于注册表自己的选项数上限(SettingItemRegistry 的 SI_ENUM_COUNT_MAX),只为给拷贝循环封顶;超出即拒绝。
const ENUM_SNAPSHOT_MAX = 4096;

function snapshotSpec(spec: object): object {
  const copy: Record<string, unknown> = { ...spec };
  const source = copy.enum;
  if (Array.isArray(source)) {
    // length 只读一次:Proxy 数组可以每次读返回不同值(先超限让这里跳过拷贝、再合法骗过注册表的数量校验;
    // 或循环中途变大让拷贝跑飞)。不在 0..上限 的整数范围内直接拒绝,绝不把插件的数组原样放进注册表。
    const length: unknown = source.length;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > ENUM_SNAPSHOT_MAX) {
      throw new Error(`[scoped-app] enum must be an array of at most ${ENUM_SNAPSHOT_MAX} options`);
    }
    // 按下标读进一个普通数组:不调用插件数组自己的 map / 迭代器 / Symbol.species(它们可以让校验的
    // for…of 与消费方的下标访问看到不同内容)。
    const options: unknown[] = [];
    for (let i = 0; i < length; i += 1) {
      const option: unknown = source[i];
      // 函数 / 数组也能挂 value、label 属性过注册表的 typeof 校验,却不会被下面的拷贝冻结 → 直接拒绝。
      // 原始值 / null / 空洞原样带过去,由注册表按「选项无效」报错。
      if (typeof option === 'function' || Array.isArray(option)) {
        throw new Error('[scoped-app] enum option must be a plain object');
      }
      options.push(isSpecObject(option) ? Object.freeze({ ...(option as object) }) : option);
    }
    copy.enum = Object.freeze(options);
  }
  return Object.freeze(copy);
}

function trackContributions<T extends object, K extends keyof T & string>(
  pluginId: string,
  name: string,
  target: T,
  /** 对插件公开的方法名(以 types.ts 的 Plugin*Api 为准);外观只含这些成员。 */
  members: readonly K[],
  life: ScopedLifecycle,
  owned: Set<() => void>,
  /** 该注册表的 key 字段与所有者标识(见 contributionOwners);events / explorerDecorators 无 key,不传。 */
  keyed?: { readonly field: 'id' | 'type'; readonly owner: string },
): Pick<T, K> {
  const liveSpec = (key: unknown): object | undefined => {
    if (typeof key !== 'string') return undefined; // 非法 key 交给注册表自身的 spec 校验报错
    const spec: unknown = (target as { get?: (k: string) => unknown }).get?.(key);
    return typeof spec === 'object' && spec !== null ? spec : undefined;
  };
  // 终审 P1(缓存查询结果里的回调绕过吊销):查询结果(spec / spec 数组 / 回调数组)按原引用缓存其包装 ——
  // 共享注册表的原对象不改,返回浅拷贝,函数字段换成带吊销检查的 Proxy(未吊销透明转发,吊销后抛 PERMISSION_DENIED)。
  // 按原引用缓存保证同一快照返回同一包装(useRegistry / memo 依赖引用稳定)。
  const guarded = new WeakMap<object, unknown>();
  // perf P2:events.on 的退订句柄按 (name, listener) 索引 —— 插件经直通的 events.off 退订后,
  // 同步把对应句柄移出 owned,不再把总线闭包与插件回调留到吊销。总线按 Set 存 listener,
  // 一次 off 即移除该 (name, listener) 的全部订阅,故摘掉该键下全部句柄。
  const subscriptions = new Map<unknown, Map<unknown, Set<() => void>>>();
  const forgetSubscriptions = (eventName: unknown, listener: unknown): void => {
    const byListener = subscriptions.get(eventName);
    const releases = byListener?.get(listener);
    if (!byListener || !releases) return;
    for (const release of releases) owned.delete(release);
    byListener.delete(listener);
    if (byListener.size === 0) subscriptions.delete(eventName);
  };
  const guardFn = (f: object, capability: string): unknown =>
    new Proxy(f, {
      apply(target, thisArg, args) {
        assertLiveUi(pluginId, capability, life);
        return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      },
      construct(target, args, newTarget) {
        assertLiveUi(pluginId, capability, life);
        return Reflect.construct(target as new (...a: unknown[]) => object, args, newTarget);
      },
      // 包装只用于调用:不给插件留下改写原函数对象(宿主 / 其它插件的回调)的通道。
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
      setPrototypeOf: () => false,
      preventExtensions: () => false,
    });
  const guardItem = (item: unknown): unknown => {
    if (typeof item !== 'object' && typeof item !== 'function') return item;
    if (item === null) return item;
    const hit = guarded.get(item);
    if (hit !== undefined) return hit;
    let out: unknown;
    if (typeof item === 'function') {
      out = guardFn(item, `${name}.callback`);
    } else {
      const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
      for (const key of Object.keys(copy)) {
        const v = copy[key];
        if (typeof v === 'function') copy[key] = guardFn(v, `${name}.${key}`);
      }
      // 嵌套的数据字段(同 snapshotSpec:目前只有 settingItems 的 enum)给冻结拷贝 —— 宿主直接注册的 spec 未经
      // 快照,原数组 / 选项对象不能交到插件手里。
      if (Array.isArray(copy.enum)) {
        copy.enum = Object.freeze(
          (copy.enum as unknown[]).map((o) => (isSpecObject(o) ? Object.freeze({ ...(o as object) }) : o)),
        );
      }
      out = Object.freeze(copy);
    }
    guarded.set(item, out);
    return out;
  };
  const guardResult = (result: unknown): unknown => {
    if (!Array.isArray(result)) return guardItem(result);
    const hit = guarded.get(result);
    if (hit !== undefined) return hit;
    const out = Object.freeze(result.map(guardItem));
    guarded.set(result, out);
    return out;
  };
  // 调用时才从注册表实例上取方法(原实例上的方法被替换,如测试 spy,照样生效)。
  const call = (prop: string, args: unknown[]): unknown =>
    (target as Record<string, (...a: unknown[]) => unknown>)[prop]!(...args);
  const build = (prop: string): ((...args: unknown[]) => unknown) => {
    const capability = `${name}.${prop}`;
    if (prop === 'off') {
      return (...args) => {
        const result = guardResult(call(prop, args));
        // 退订句柄本身不吊销(插件仍持有的旧 Disposable 再 dispose 照旧转发到总线),仅不再由 owned 持有。
        forgetSubscriptions(args[0], args[1]);
        return result;
      };
    }
    if (PASSTHROUGH_METHODS.has(prop)) {
      return (...args) => guardResult(call(prop, args));
    }
    if (prop === 'clear' && name === 'events') {
      // 安全:总线的 clear() 清空全部订阅、clear(name) 清空该事件的全部订阅(含宿主与其它插件的)。
      // 插件只能清自己经本 scoped app 订阅的:逐个走退订句柄(与 dispose / off 同一路径)。
      return (...args) => {
        assertLiveUi(pluginId, capability, life);
        const eventNames = args[0] === undefined ? [...subscriptions.keys()] : [args[0]];
        for (const eventName of eventNames) {
          for (const releases of [...(subscriptions.get(eventName)?.values() ?? [])]) {
            for (const release of [...releases]) release();
          }
        }
      };
    }
    if (!CONTRIBUTION_METHODS.has(prop)) {
      return (...args) => {
        if (life.revoked && ASYNC_METHODS.has(prop)) {
          return Promise.reject(codedError('PERMISSION_DENIED', revokedMessage(pluginId, capability)));
        }
        assertLiveUi(pluginId, capability, life);
        return call(prop, args);
      };
    }
    return (...rawArgs) => {
      assertLiveUi(pluginId, capability, life);
      // 安全(TOCTOU):spec 来自插件,字段可以是 getter(首次返回诱饵 key、之后返回宿主的 key)。所有权检查与
      // 注册表若各读一次,检查看到的 key 与入表的 key 就可以不同。这里只读一次:浅拷贝成冻结快照(展开对每个
      // 自有属性恰好取值一次,函数字段保持引用),检查、入表、登记所有者都用这一份。非对象 spec 原样交给注册表报错。
      const args =
        keyed !== undefined && prop === 'register' && isSpecObject(rawArgs[0])
          ? [snapshotSpec(rawArgs[0] as object), ...rawArgs.slice(1)]
          : rawArgs;
      const key: unknown =
        keyed !== undefined && prop === 'register'
          ? (args[0] as Record<string, unknown> | null | undefined)?.[keyed.field]
          : undefined;
      const existing = liveSpec(key);
      if (keyed !== undefined && existing !== undefined && contributionOwners.get(existing) !== keyed.owner) {
        throw codedError(
          'PERMISSION_DENIED',
          `[${name}] ${keyed.field} "${String(key).slice(0, 128)}" is already registered by the host or another plugin; plugin ${pluginId} cannot override it`,
        );
      }
      const handle = call(prop, args) as Disposable | (() => void);
      const registered = liveSpec(key);
      if (keyed !== undefined && registered !== undefined) contributionOwners.set(registered, keyed.owner);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        owned.delete(release);
        if (prop === 'on') {
          const releases = subscriptions.get(args[0])?.get(args[1]);
          releases?.delete(release);
          if (releases?.size === 0) forgetSubscriptions(args[0], args[1]);
        }
        if (typeof handle === 'function') handle();
        else handle.dispose();
      };
      owned.add(release);
      if (prop === 'on') {
        let byListener = subscriptions.get(args[0]);
        if (!byListener) {
          byListener = new Map();
          subscriptions.set(args[0], byListener);
        }
        let releases = byListener.get(args[1]);
        if (!releases) {
          releases = new Set();
          byListener.set(args[1], releases);
        }
        releases.add(release);
      }
      return typeof handle === 'function' ? release : { dispose: release };
    };
  };
  // 外观:普通对象(原型 Object.prototype),自有属性只有 members 列出的方法;方法是不读 this 的箭头闭包。
  // 外观与方法都冻结 —— 插件拿不到注册表实例,也就拿不到它的内部字段、受保护方法与原型方法。
  const facade: Record<string, unknown> = {};
  for (const prop of members) facade[prop] = Object.freeze(build(prop));
  return Object.freeze(facade) as Pick<T, K>;
}

const EMPTY_GRANTED_PERMISSIONS: PermissionKey[] = [];

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
      if (!store) return EMPTY_GRANTED_PERMISSIONS;
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

/** 只读视图:get 仅返回 declared 内的决策;scoped-app 只经 get 读授权。 */
function restrictToDeclared(
  store: PermissionStore,
  declared: readonly PermissionKey[],
): PermissionStore {
  const allowed = new Set(declared);
  return {
    async get(pluginId) {
      const decisions = await store.get(pluginId);
      return decisions.filter((d) => allowed.has(d.permission));
    },
    grant: (pluginId, perms) => store.grant(pluginId, perms),
    deny: (pluginId, perms) => store.deny(pluginId, perms),
    clearDenied: (pluginId) => store.clearDenied(pluginId),
  };
}

/**
 * per-instance scoped app 及其控制面(PluginManager 持有,插件拿不到)。
 */
export interface ScopedAppController {
  readonly app: CoPluginApp;
  /**
   * 吊销(幂等,不可恢复):之后有外部副作用的能力一律拒绝、不发 IPC(见文件头);本实例经 scoped app
   * 注册的贡献点、事件订阅与 MCP 工具一并注销。插件实例离开运行态时先于 onunload 调用。
   */
  revoke(): void;
  /** 授权变更后重查 mcp-tools:已无授权 → 注销本实例经 app.mcp 注册的全部工具. */
  recheckMcpPermission(): Promise<void>;
}

/**
 * 把 coApp 包成 per-plugin CoPluginApp。Plugin constructor 拿到的就是它。
 *
 * - 贡献点字段(panels/commands/...)是 trackContributions 构造的冻结外观(随吊销拒绝 + 注销),底层仍是 coApp 单例
 * - fs/network/clipboard/shell/permission 是 per-plugin 闭包,持 pluginId
 */
export function createScopedAppController(
  coApp: CoApp,
  pluginId: string,
  rawStore: PermissionStore | null,
  token?: string,
  declared?: readonly PermissionKey[],
): ScopedAppController {
  // 有效权限 = 当前 manifest 声明 ∩ 用户已授权:插件升级删掉某权限声明后,持久化里的
  // 旧授权不得继续生效。传入 declared 时把 store.get 视图裁到声明集合,所有 ensurePerm /
  // permission.check/granted 自动走同一语义;未传(core plugin / 测试)保持旧行为。
  const store = rawStore && declared ? restrictToDeclared(rawStore, declared) : rawStore;
  const life: ScopedLifecycle = { revoked: false, inflightFetches: new Set() };
  // 本实例经共享注册表 / 事件总线登记的贡献与订阅(revoke 时统一注销)。
  const owned = new Set<() => void>();
  // 贡献点 key 的所有者标识(见 contributionOwners)。PluginManager 激活第三方插件总是带 plugin-fs token;不带 token 的
  // 是宿主自建的 scoped app(内置插件)。二者分属不同命名空间 —— 第三方插件把 manifest id 起成内置插件的 id
  //(如 `core.plugins`)也不算内置条目的所有者。同一插件重载后的新实例标识不变,可覆盖自己的旧条目。
  const owner = `${token === undefined ? 'core' : 'plugin'}:${pluginId}`;
  const track = <T extends object, K extends keyof T & string>(
    name: string,
    target: T,
    members: readonly K[],
    keyField?: 'id' | 'type',
  ): Pick<T, K> =>
    trackContributions(
      pluginId,
      name,
      target,
      members,
      life,
      owned,
      keyField === undefined ? undefined : { field: keyField, owner },
    );
  // 插件拿到的 app 逐字段显式构造(不展开 coApp:将来给 CoApp 加字段不会自动透给插件)。贡献点注册表 / events 是
  // 只含公开方法的冻结外观(成员清单须与 types.ts 的 Plugin*Api 一致,少列一个 tsc 报错);mcp / editor / dock /
  // notifications / dataStore / workspace 是 per-plugin 闭包,同样不交出宿主单例对象。
  const mcp = makeMcp(pluginId, store, coApp.mcp, life);
  const app: CoPluginApp = {
    version: coApp.version,
    panels: track('panels', coApp.panels, [...KEYED_MEMBERS, 'list'], 'type'),
    commands: track('commands', coApp.commands, [...KEYED_MEMBERS, 'execute'], 'id'),
    statusBar: track('statusBar', coApp.statusBar, [...KEYED_MEMBERS, 'getBySide'], 'id'),
    ribbon: track('ribbon', coApp.ribbon, KEYED_MEMBERS, 'id'),
    events: track('events', coApp.events, ['on', 'off', 'emit', 'clear']),
    settingTabs: track('settingTabs', coApp.settingTabs, KEYED_MEMBERS, 'id'),
    settingItems: track('settingItems', coApp.settingItems, [...KEYED_MEMBERS, 'getByCategory'], 'id'),
    explorerDecorators: track('explorerDecorators', coApp.explorerDecorators, ['register', 'getAll', 'subscribe']),
    editorActions: track('editorActions', coApp.editorActions, KEYED_MEMBERS, 'id'),
    explorerContextMenu: track('explorerContextMenu', coApp.explorerContextMenu, KEYED_MEMBERS, 'id'),
    // 宿主的 workspace 是全窗口共用的单例对象:原样透传的话,一个插件改写 getRoot 会影响所有插件。
    workspace: Object.freeze({ getRoot: Object.freeze(() => coApp.workspace.getRoot()) }),
    dataStore: makeDataStore(pluginId, coApp.dataStore),
    editor: makeEditor(pluginId, store, coApp.editor, life, token),
    dock: makeDock(pluginId, coApp.dock, life),
    notifications: makeNotifications(pluginId, coApp.notifications, life),
    fs: makeFs(pluginId, store, life, token),
    network: makeNetwork(pluginId, store, life),
    shell: makeShell(pluginId, store, life),
    clipboard: makeClipboard(pluginId, store, life),
    permission: makePermission(pluginId, store),
    mcp: mcp.api,
  };
  return {
    app,
    revoke: () => {
      life.revoked = true;
      // 中止在途 network.fetch(发起前的吊销检查拦不住已发出的请求)。
      for (const ctl of [...life.inflightFetches]) ctl.abort();
      life.inflightFetches.clear();
      // 单个注销抛错不传染(同 Plugin 的 LIFO 清理)。
      for (const release of [...owned]) {
        try {
          release();
        } catch (err) {
          console.warn(`[scoped-app] ${pluginId} revoke: dispose contribution failed`, err);
        }
      }
      // 插件不保存 app.mcp.register 返回的 Disposable 时,工具与 main stub 会残留 → 再启用同名注册 TOOL_NAME_TAKEN。
      mcp.disposeAll();
    },
    recheckMcpPermission: mcp.recheck,
  };
}

/** 不需要控制面的调用方(core plugin / 测试)用:只返回 scoped app。 */
export function createScopedApp(
  coApp: CoApp,
  pluginId: string,
  rawStore: PermissionStore | null,
  token?: string,
  declared?: readonly PermissionKey[],
): CoPluginApp {
  return createScopedAppController(coApp, pluginId, rawStore, token, declared).app;
}
