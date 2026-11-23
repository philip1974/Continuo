import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { IpcMain } from 'electron';
import { PLUGIN_FS_CHANNELS, SCOPE_REQUEST_ID_MAX } from '../../shared/plugin-fs-channels';
import { createByteCappedBuffer } from '../lib/byte-capped-buffer';
import { makeWcGoneHook } from '../lib/wc-gone-hook';
import { IdentityRegistry } from './identity-registry.service';
import { PathScopeRegistry } from './path-scope-registry.service';
import {
  SCOPE_REQUEST_PLUGIN_UNREGISTERED,
  ScopeRequestCorrelator,
} from './scope-request-correlator';
import { ScopeRequestThrottle, scopeThrottleKeys } from './scope-request-throttle';
import {
  PLUGIN_FS_EDITOR_READ_SCOPE_DENIED,
  ScopeError,
  ScopeRequestTimeoutError,
  type PathScope,
  type PluginFsEditorRead,
} from '../../shared/plugin-fs-contract';
import { canonicalizeScopePath } from './path-resolve.helper';
import { atomicReplaceFileNoFollow } from '../ipc/fs/atomic-write';
import { readFileFromHandle, type ReadFileOptions } from '../ipc/fs/read-file';
import { openForReadNonBlocking } from '../lib/read-fh-capped';
import { createRwLock } from '../lib/rw-lock';
import {
  FS_PATH_MAX,
  FS_PATH_MAX_DEPTH,
  MAX_WRITE_BYTES,
  pathDepthExceeds,
  validateScopesShape,
  isValidGitBlobSha,
} from '../../shared/fs-limits';
import { utf8BytesExceed } from '../../shared/utf8-byte-length';
import { fsError, isCaseOrNormalizationOnlyRename, mapNodeErrnoCode } from '../ipc/fs/path-utils';
import { ERROR_CODES } from '../../shared/error-codes';
import { errorMessage } from '../../shared/error-message';
import { isSafePluginId } from './plugins.service';
import {
  GIT_OFFLINE_ENV,
  mergeSpawnEnv,
  resolveSpawnCommand,
  stripGitRepoRedirectEnv,
  stripInternalSecretEnv,
  withGitHardeningEnv,
} from '../lib/child-spawn-hardening';

export interface PluginFsDeps {
  identityRegistry: IdentityRegistry;
  pathScopeRegistry: PathScopeRegistry;
  correlator: ScopeRequestCorrelator;
  /**
   * 冷启动水合:返回该 plugin 上次会话持久化的 path scope(canonical)。
   * 未注入(如测试)→ 跳过水合,行为同改造前(每次都弹窗)。
   */
  loadPersistedScopes?: (pluginId: string) => Promise<readonly PathScope[]>;
  /** 持久化该 plugin 当前全部已授 scope,供下次启动水合。best-effort。 */
  persistScopes?: (
    pluginId: string,
    scopes: readonly PathScope[],
  ) => Promise<void>;
}

const TRASH_TTL_MS = 24 * 60 * 60 * 1000;
const TRASH_PREFIX = '.trash-';

// 边界(E30):plugin-fs:list-dir 单层目录条目数硬上限(滥用 backstop,防超大数组 + IPC 全量返回)。
// 导出供测试用(避免在测试里硬编码 magic number)。
export const MAX_LIST_DIR_ENTRIES = 100_000;
// 递归 cp 的条目总数上限(含根):cp 持独占锁运行,上限同时限定最坏持锁时间;超限 fail-closed(FS_DIR_TOO_LARGE)。
export const MAX_CP_ENTRIES = 100_000;

// 安全(校验 → 操作竞态):每个 handler 都是「scope 校验(realpath)→ 按得到的路径字符串操作」,两步之间路径由
// OS 重新解析,而 Node 没有 openat。插件可用**自己的**变更调用在这个间隙把路径上的某一级目录换成指向 scope 外的
// 既有符号链接(并发 rename,或 atomicReplaceWithinScope 把含外链的目录原子换到被访问的目录上)—— 实测 cp 越界读
// 数百次 / 6000、writeFile 写穿与 mkdir 越界建目录各数次 / 6000;叶子 no-follow 挡不住目录级替换。
// 只经 SDK 的插件改动目录结构的唯一手段就是 plugin-fs 的变更调用,所以用一把进程内读写锁把它们与其它调用的
// 「校验 + 操作」整段互斥:变更类(writeFile / mkdir / rename / rm / cp / atomicReplaceWithinScope,含 trash 清扫)
// 取独占,只读类(readFile / listDir / stat / lstat / readGitBlob)取共享。全局一把而非每插件一把:
// 不同插件的 scope 可重叠,可能合谋。
// 约束:持锁期间不得等待用户交互、不得再调用需要这把锁的入口(不可重入,会死锁)—— requestScope / 注册 /
// 注销不取锁(它们不调用 pathScopeRegistry.check)。realpath 的处理器本身在校验之后不再做文件系统
// 操作,取共享锁是因为 check 的身份缓存要求调用方持锁(见 pluginFsIdentityEpoch)。
// 不提供「只回答此刻是否在 scope 内」的探测端点:调用方拿布尔值再经别的通道按路径字符串读 / 写,就把
// 「校验 → 操作」拆到了锁外(editor.openFile 曾如此:校验通过后并发换入链接,宿主按原路径读到 scope 外的文件)。
// 需要「校验后操作」的调用方必须让主进程在同一次持锁内做完 —— 见 READ_FOR_EDITOR 与 guardPluginOpenedPath。
// 残余:锁只管 plugin-fs 自己的调用。有 shell 权限的插件(可运行任意命令,本就等于完全访问)、用户自己的进程、
// 其它应用对同一目录的并发改动不在此列。
const fsLock = createRwLock();

/**
 * PathScopeRegistry 身份缓存的代际(见该处 IdentityCacheOptions):独占锁的累计授予次数;有独占持有者在运行时
 * 返回 null(不缓存)。由 plugin-fs.ipc 注入 registry。
 */
export function pluginFsIdentityEpoch(): number | null {
  return fsLock.isExclusiveHeld() ? null : fsLock.exclusiveGrants();
}
// 安全(插件打开的编辑器标签,之后的读 / 写):标签绑定的是打开时的 canonical 路径(不含任何链接),但宿主之后
// 的保存、保存前比对、外部修改重载都经受信通道**按路径**进行。插件可在打开之后把路径上的某一级换成指向 scope
// 外的链接:用户在标签里编辑并保存 → 内容落到 scope 外;未修改的标签被外部同步重载 → scope 外的文件显示在标签里。
// 所以记下这些路径,宿主对它们的读 / 写在共享锁内先确认「路径仍是 canonical」(realpath 仍等于自身 —— 途中没有
// 被换入链接),确认与操作在同一次持锁内。不比 (dev, ino):编辑器保存是「临时文件 + rename」,每次保存 inode
// 都会变,正常的外部原子保存也一样;而越出 scope 必须经过链接,比 realpath 正好。
// 记录与标签生命周期绑定:每次成功的 read-for-editor 记一份(按发起窗口的 webContents 计数);renderer 用这份
// 内容新建了标签 → 由该标签持有,标签关闭时经 plugin-fs:release-editor-path 释放;没有新建标签(已开着只切换 /
// 打开失败 / 插件已吊销)→ 当即释放。窗口关闭 / renderer 重载时整窗释放(见 wc-gone 钩子)。
// 数量有上限且**不淘汰**:满了以后新的 read-for-editor 以 FS_BUSY 拒绝,已有记录照常生效。此前按最近使用淘汰,
// 插件再打开 4096 个别的文件就能把目标路径挤出记录、解除保护(审计 F2)。
// 名额按插件:每插件至多 PLUGIN_OPENED_PATHS_PER_PLUGIN_MAX 份(同一插件各窗口 / 各实例合计),全部插件合计至多
// PLUGIN_OPENED_PATHS_MAX 份。此前只有全局上限:一个插件连续 openFile 4096 次即让所有插件的 openFile 失败,直到
// 用户关掉标签。释放通道只带路径(宿主编辑器不知道标签是哪个插件开的):同一窗口同一路径的多份按后进先出归还 ——
// 「已开着只切换 / 被吊销」的当即释放正好是刚记的那份;同一窗口同一路径通常只有一个标签,归属偏差至多在同窗口的
// 插件之间挪动名额,全局上限不受影响。
export const PLUGIN_OPENED_PATHS_MAX = 4096;
export const PLUGIN_OPENED_PATHS_PER_PLUGIN_MAX = 1024;
/** canonical 路径 → (webContents id → 各份的 pluginId,按记录顺序) */
const pluginOpenedPaths = new Map<string, Map<number, string[]>>();
let pluginOpenedRefs = 0;
/** pluginId → 份数(归零即删除) */
const pluginOpenedRefsByPlugin = new Map<string, number>();

function releasePluginOpenedRef(pluginId: string): void {
  const n = pluginOpenedRefsByPlugin.get(pluginId) ?? 0;
  if (n > 1) pluginOpenedRefsByPlugin.set(pluginId, n - 1);
  else pluginOpenedRefsByPlugin.delete(pluginId);
  pluginOpenedRefs -= 1;
}

/** 记一份;该插件或全局已满 → false(不记)。 */
function pinPluginOpenedPath(canonical: string, wcId: number, pluginId: string): boolean {
  const own = pluginOpenedRefsByPlugin.get(pluginId) ?? 0;
  if (pluginOpenedRefs >= PLUGIN_OPENED_PATHS_MAX || own >= PLUGIN_OPENED_PATHS_PER_PLUGIN_MAX) return false;
  let holders = pluginOpenedPaths.get(canonical);
  if (holders === undefined) {
    holders = new Map();
    pluginOpenedPaths.set(canonical, holders);
  }
  let refs = holders.get(wcId);
  if (refs === undefined) {
    refs = [];
    holders.set(wcId, refs);
  }
  refs.push(pluginId);
  pluginOpenedRefsByPlugin.set(pluginId, own + 1);
  pluginOpenedRefs += 1;
  return true;
}

/** 释放该窗口对该路径的一份(没有则 no-op)。 */
function unpinPluginOpenedPath(canonical: string, wcId: number): void {
  const holders = pluginOpenedPaths.get(canonical);
  const refs = holders?.get(wcId);
  if (holders === undefined || refs === undefined) return;
  releasePluginOpenedRef(refs.pop()!);
  if (refs.length === 0) holders.delete(wcId);
  if (holders.size === 0) pluginOpenedPaths.delete(canonical);
}

/** 窗口关闭 / renderer 重载:该窗口的标签都已不在,释放它持有的全部记录。 */
function unpinPluginOpenedPathsOf(wcId: number): void {
  for (const [path, holders] of pluginOpenedPaths) {
    const refs = holders.get(wcId);
    if (refs === undefined) continue;
    holders.delete(wcId);
    for (const pluginId of refs) releasePluginOpenedRef(pluginId);
    if (holders.size === 0) pluginOpenedPaths.delete(path);
  }
}

/** 路径是否仍是 canonical。尚不存在(保存会重建)时:父目录仍 canonical,且叶子不是悬空链接。无法确认 → false。 */
async function isStillCanonical(p: string): Promise<boolean> {
  try {
    return (await fs.realpath(p)) === p;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  try {
    if ((await lstatOrNull(p)) !== null) return false;
    return join(await fs.realpath(dirname(p)), basename(p)) === p;
  } catch {
    return false;
  }
}

/**
 * 宿主编辑器通道(fs:read-file / fs:write-file)对路径的读 / 写经此包一层:路径是插件经 editor.openFile 打开过的
 * → 在共享锁内确认它仍是 canonical 再运行 task,否则以 FS_DENIED 拒绝;其它路径直接运行 task(不取锁、不多任何
 * 文件系统调用)。task 不得再申请 plugin-fs 的锁。
 */
export function guardPluginOpenedPath<T>(path: string, task: () => Promise<T>): Promise<T> {
  if (!pluginOpenedPaths.has(path)) return task();
  return fsLock.shared(async () => {
    if (!(await isStillCanonical(path))) {
      console.warn(`[plugin-fs] host editor access refused: plugin-opened path no longer canonical: ${path}`);
      throw fsError(
        ERROR_CODES.FS_DENIED,
        `path now passes through a symbolic link that was not there when a plugin opened it: ${path}`,
      );
    }
    return task();
  });
}

/** Test-only:清空「插件打开过的路径」记录。 */
export function _resetPluginOpenedPathsForTest(): void {
  pluginOpenedPaths.clear();
  pluginOpenedRefsByPlugin.clear();
  pluginOpenedRefs = 0;
}

/** Test-only:「插件打开过的路径」记录的总份数(给 pluginId 则只计该插件的)。 */
export function _pluginOpenedPathRefsForTest(pluginId?: string): number {
  return pluginId === undefined ? pluginOpenedRefs : (pluginOpenedRefsByPlugin.get(pluginId) ?? 0);
}

// 边界(内存峰值):单次读取有上限(read-file / read-for-editor 64MiB、read-git-blob 64MB、list-dir 10 万条),但并发
// 次数此前无限制 —— 插件 Promise.all 几十个大文件读取即可把主进程撑大数 GB(实测 96 × 30MB 文件 RSS +3.5GB)。
// 这几个「单次可占大块内存」的入口共用一个全局闸:同时在途至多 PLUGIN_FS_HEAVY_READ_CONCURRENCY 个,其余排队;
// 排队者只持有参数(路径),排队长度也有上限,超限立即以 FS_BUSY 拒绝。
// 安全(插件之间的饥饿):名额按插件(pluginId,不按 token —— 同一插件多窗口 / 多实例共享,多开窗口不放大)计:
// 每插件在途 + 排队至多 PLUGIN_FS_HEAVY_READ_PER_PLUGIN_MAX 个,超出只拒绝该插件;有空位时在有排队的插件之间
// 轮转放行(同一插件内按到达顺序)。此前是一条全局队列:一个插件保持上千个排队读取,其它插件的 readFile /
// listDir / editor.openFile 全部 FS_BUSY(审计实测)。全局排队上限保留作总量兜底。
// 嵌套顺序:先取闸、后取 plugin-fs 读写锁的共享锁。反过来(持共享锁排队等闸)时,排队者都算共享持有者,独占写者
// 要等整条队列读完才能开始;现在排队者不持锁,写者只需等至多 4 个在途读取。写者不取闸,不会互相等待成环。
// 宿主自己的 fs:read-file(用户编辑器)不经此闸 —— 插件占满闸也不影响用户打开文件。
// 其它入口:stat / lstat / realpath 的结果是常数大小;write-file / rename / cp / mkdir / rm /
// atomicReplace 持独占锁,本就串行(cp 经 copyFile 在内核里复制,不进 JS 堆)。
export const PLUGIN_FS_HEAVY_READ_CONCURRENCY = 4;
export const PLUGIN_FS_HEAVY_READ_QUEUE_MAX = 1024;
export const PLUGIN_FS_HEAVY_READ_PER_PLUGIN_MAX = 64;
let heavyReadActive = 0;
let heavyReadPending = 0; // 全部插件的在途 + 排队
/** 有在途或排队读取的插件:在途 + 排队数、排队者(FIFO)。归零即删除。 */
const heavyReadByPlugin = new Map<string, { pending: number; waiting: (() => void)[] }>();
/** 有排队者的插件,轮转顺序(每个至多出现一次)。 */
const heavyReadTurns: string[] = [];

function dispatchHeavyReads(): void {
  while (heavyReadActive < PLUGIN_FS_HEAVY_READ_CONCURRENCY && heavyReadTurns.length > 0) {
    const key = heavyReadTurns.shift()!;
    const waiting = heavyReadByPlugin.get(key)!.waiting;
    const start = waiting.shift()!;
    if (waiting.length > 0) heavyReadTurns.push(key);
    heavyReadActive += 1;
    start();
  }
}

/** key:发起插件的 pluginId(未知 token 归入同一个桶,随后的 scope 校验会拒绝它)。 */
function heavyRead<T>(key: string, task: () => Promise<T>): Promise<T> {
  let entry = heavyReadByPlugin.get(key);
  if (
    heavyReadPending >= PLUGIN_FS_HEAVY_READ_CONCURRENCY + PLUGIN_FS_HEAVY_READ_QUEUE_MAX ||
    (entry?.pending ?? 0) >= PLUGIN_FS_HEAVY_READ_PER_PLUGIN_MAX
  ) {
    return Promise.reject(fsError(ERROR_CODES.FS_BUSY, 'too many plugin file reads in progress; try again later'));
  }
  if (entry === undefined) {
    entry = { pending: 0, waiting: [] };
    heavyReadByPlugin.set(key, entry);
  }
  const own = entry;
  own.pending += 1;
  heavyReadPending += 1;
  const acquired = new Promise<void>((resolve) => {
    own.waiting.push(resolve);
    if (own.waiting.length === 1) heavyReadTurns.push(key);
  });
  dispatchHeavyReads();
  return acquired
    .then(() => fsLock.shared(task))
    .finally(() => {
      heavyReadActive -= 1;
      heavyReadPending -= 1;
      own.pending -= 1;
      if (own.pending === 0) heavyReadByPlugin.delete(key);
      dispatchHeavyReads();
    });
}

// 包装 handler:返回类型留给 ipcMain.handle 做上下文推断,handler 的参数类型标注保持原样。
const shared =
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  (...args: A): Promise<R> =>
    fsLock.shared(() => fn(...args));
const exclusive =
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  (...args: A): Promise<R> =>
    fsLock.exclusive(() => fn(...args));

// 边界(E31/E239):plugin-fs:request-scope 的 scopes 是插件直传 IPC payload。数量/路径长度上限 + mode
// 枚举收口到 shared(fs-limits.validateScopesShape),main 与 renderer scoped-app 共用单一来源。此处
// 边界(E96):scope-decision 的 requestId 上限(correlator 用的是 UUID,~36 字符,256 留足余量)。
// 边界(E315,E234 并发 fan-out 同族):单次 request-scope 最多 MAX_SCOPE_REQUEST_COUNT(64)条,路径归一化要
// realpath。全量 Promise.all 会把它们同时打进主进程/libuv。固定 worker 池平滑 IO 峰值,
// 顺序仍由 canonicalizePathScopes 的结果数组按输入下标保持。
const CANONICALIZE_SCOPE_CONCURRENCY = 16;

// 审计 P2-B:git cat-file 子进程的超时与输出上限。旧实现无 timeout、stdout 无界,
// 超大 blob 或 git 卡死(如 cwd 在网络挂载)会让 Promise 永不 resolve + 内存持续增长。
const GIT_BLOB_TIMEOUT_MS = 30_000;
const GIT_BLOB_MAX_BYTES = 64 * 1024 * 1024; // 64 MB 上限,够大但防 OOM
// 边界(E63,E62 同款):cat-file stderr 累积上限(失败时拼进 ScopeError message)。
const GIT_BLOB_STDERR_MAX = 64 * 1024;
// 边界(E63 / E314):git blob sha hex 形态校验收口到 shared/fs-limits(renderer scoped-app readGitBlob
// 发 IPC 前同款预检,单一来源防漂移)。

/** 已逐项校验在插件只读 scope 内的仓库位置(canonical);readGitBlob 据此钉死 git 读哪个对象库。 */
export interface GitObjectStorePin {
  gitDir: string;
  commonDir: string;
  objectDir: string;
}

// rev-parse 只输出两行路径,给足余量即可。
const GIT_REV_PARSE_MAX_BYTES = 64 * 1024;

/**
 * readGitBlob 的 git 子进程 env:剥离宿主机密与会重定向仓库 / 对象库的 GIT_*(见 stripGitRepoRedirectEnv),
 * 再加 git 兜底配置与离线预设(说明见 readGitBlob 内注释)。
 */
function gitBlobEnv(): NodeJS.ProcessEnv {
  return mergeSpawnEnv(
    withGitHardeningEnv(stripGitRepoRedirectEnv(stripInternalSecretEnv(process.env))),
    GIT_OFFLINE_ENV,
  );
}

function gitStoreOutOfScope(cwd: string, reason: string, cause?: unknown): ScopeError {
  // 对插件只有这一条文案:「不是仓库」「仓库在 scope 外」「git 太旧」不可区分(否则成了 scope 外 .git 的探测器)。
  // 具体原因进主进程日志供排错。
  console.warn(`[plugin-fs] readGitBlob rejected (${reason}) cwd=${cwd}`);
  return new ScopeError('git repository not found within granted scope', { target: cwd }, { cause });
}

/**
 * 安全:`git cat-file` 读哪个对象库由 git 决定,与 cwd 是否在 scope 内无关 —— 向上发现到 scope 外的 `.git`、
 * `.git` 文件(`gitdir: <任意仓库>`)、`objects/info/alternates`、指向别处的 `objects` 符号链接都会让只校验
 * cwd 的 readGitBlob 读到 scope 外的对象。这里先问 git 实际会用的 gitdir / commondir,要求它们与对象目录
 * (及本次可能读到的扇出目录 / 对象文件 / pack 目录)realpath 后都在只读 scope 内,带 alternates 的对象库
 * 一律拒绝。`realpathInScope` 须返回 realpath 后的路径,不在 scope 内 / 不存在时抛错。
 * git < 2.31 不认 `--path-format`(原样回显该选项,输出不是「恰好两行绝对路径」)→ fail-closed。
 */
export async function resolveGitObjectStoreInScope(
  cwd: string,
  sha: string,
  realpathInScope: (p: string) => Promise<string>,
): Promise<GitObjectStorePin> {
  const env = gitBlobEnv();
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        resolveSpawnCommand('git', env),
        ['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'],
        { cwd, env, timeout: GIT_BLOB_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: GIT_REV_PARSE_MAX_BYTES },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
  } catch (err) {
    throw gitStoreOutOfScope(cwd, 'rev-parse failed', err);
  }
  const lines = stdout.replace(/\r?\n$/, '').split(/\r?\n/);
  if (lines.length !== 2 || !lines.every((l) => isAbsolute(l))) {
    throw gitStoreOutOfScope(cwd, 'unexpected rev-parse output (git < 2.31?)');
  }
  let pin: GitObjectStorePin;
  try {
    const gitDir = await realpathInScope(lines[0]!);
    const commonDir = await realpathInScope(lines[1]!);
    const objectDir = await realpathInScope(join(commonDir, 'objects'));
    pin = { gitDir, commonDir, objectDir };
    // 对象目录之下,本次读取可能经过的路径同样不能经符号链接落到 scope 外:松散对象的扇出目录与文件、pack 目录。
    for (const sub of [sha.slice(0, 2), join(sha.slice(0, 2), sha.slice(2)), 'pack']) {
      const p = join(objectDir, sub);
      if (await lstatOrNull(p)) await realpathInScope(p);
    }
    // pack 目录内的条目(.pack / .idx / multi-pack-index)逐个 realpath 成本高,直接拒绝符号链接条目。
    for (const e of await readdirOrEmpty(join(objectDir, 'pack'))) {
      if (e.isSymbolicLink()) throw new Error(`symlink in pack dir: ${e.name}`);
    }
  } catch (err) {
    throw gitStoreOutOfScope(cwd, 'object store not within scope', err);
  }
  // alternates 让 git 额外去读任意对象目录;不逐项判定,存在且非空即拒。无法确认(非 ENOENT 错误)也拒。
  for (const dir of new Set([pin.objectDir, join(pin.gitDir, 'objects')])) {
    const alternates = join(dir, 'info', 'alternates');
    let st: Awaited<ReturnType<typeof lstatOrNull>>;
    try {
      st = await lstatOrNull(alternates);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
      throw gitStoreOutOfScope(cwd, 'cannot stat alternates', err);
    }
    if (st && (!st.isFile() || st.size > 0)) {
      throw new ScopeError('git repository uses objects/info/alternates; refusing to read', {
        target: cwd,
        reason: 'alternates',
      });
    }
  }
  return pin;
}

async function readdirOrEmpty(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return [];
  }
}

/**
 * 读取单个 git blob(`git cat-file blob <sha>`),带超时与字节上限。
 * 超时 / 超限 / spawn 错误 → SIGKILL 子进程并 reject。可注入 opts 供测试用小值。
 * `opts.pin`(resolveGitObjectStoreInScope 的结果)把 gitdir / commondir / 对象目录钉成已校验的路径:
 * git 不再自行发现仓库,校验之后再改 `.git` 文件或 `objects` 链接不影响本次读取。
 */
export function readGitBlob(
  cwd: string,
  sha: string,
  opts?: { timeoutMs?: number; maxBytes?: number; pin?: GitObjectStorePin },
): Promise<Uint8Array> {
  const timeoutMs = opts?.timeoutMs ?? GIT_BLOB_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? GIT_BLOB_MAX_BYTES;
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    // 安全:cat-file 不读 index、不触发 fsmonitor,但零成本带上同款 git 兜底 env(防将来改用读 index 的子命令)。
    // Windows 上 `git` 只在 PATH 绝对目录中解析,不执行仓库目录下的 git.exe;解析不到抛错 → 本 Promise reject。
    // 安全(纵深):恶意 `.git/config` 设 extensions.partialClone + remote.<r>.uploadpack=<cmd> 时,缺失 blob
    // 触发惰性拉取即执行该命令。禁用拉取:GIT_NO_LAZY_FETCH=1(git ≥2.45)+ `-c protocol.allow=never`
    //(任何传输协议一律拒绝,低版本 git 也认)。只读本地对象库,缺失即失败。
    // 但 `protocol.<name>.allow` 优先于 `protocol.allow`:仓库 config 写 `protocol.file.allow=always` 即盖过
    // 命令行的 never,git <2.45 又不认 GIT_NO_LAZY_FETCH → 仍会执行。GIT_ALLOW_PROTOCOL 设为空(空白名单)
    // 时 git 忽略全部 protocol.*.allow 配置、拒绝一切传输(git ≥2.12 认),仓库 config 无法覆盖。
    // 两者即具名预设 GIT_OFFLINE_ENV;并剥离宿主内部机密(CONTINUO_MCP_TOKEN)与重定向仓库的 GIT_*。
    const pin = opts?.pin;
    const env = pin
      ? mergeSpawnEnv(gitBlobEnv(), {
          GIT_DIR: pin.gitDir,
          GIT_COMMON_DIR: pin.commonDir,
          GIT_OBJECT_DIRECTORY: pin.objectDir,
        })
      : gitBlobEnv();
    const child = spawn(
      resolveSpawnCommand('git', env),
      ['-c', 'protocol.allow=never', 'cat-file', 'blob', sha],
      { cwd, env },
    );
    // 边界(E63 + E132,E131 同款):按真实 UTF-8 字节累积/截断 stderr,decode 延后整体进行。
    const stderrCap = createByteCappedBuffer(GIT_BLOB_STDERR_MAX);
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(err);
    };
    const timer = setTimeout(
      () =>
        fail(
          new ScopeError(`git cat-file timed out after ${timeoutMs}ms`, {
            target: sha,
          }),
        ),
      timeoutMs,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(
          new ScopeError(`git blob exceeds ${maxBytes} bytes`, { target: sha }),
        );
        return;
      }
      chunks.push(chunk);
    });
    // 边界(E63 + E132):stderr 累积上限(按真实字节),超限停止追加(防超大错误输出膨胀 + 撑爆 message)。
    child.stderr.on('data', (chunk: Buffer) => stderrCap.push(chunk));
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(new Uint8Array(Buffer.concat(chunks)));
        return;
      }
      reject(
        new ScopeError(`git cat-file failed (exit ${code}): ${stderrCap.text()}`, {
          target: sha,
        }),
      );
    });
    child.on('error', (err) => fail(err));
  });
}

interface StatPayload {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

function statPayload(s: {
  size: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): StatPayload {
  return {
    size: s.size,
    mtimeMs: s.mtimeMs,
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymlink: s.isSymbolicLink(),
  };
}

/**
 * lstat,目标不存在(ENOENT)→ null;其它错误(EACCES / EIO / ELOOP …)照抛 —— 「无法确认目标是否
 * 存在」不能当作不存在(fail-closed),否则后续 rename / cp 可能静默覆盖实际存在的目标。
 */
async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return null;
  }
}

/**
 * 纵深(锁管不到的外部改动):按校验得到的 canonical 路径打开,拿到 fd 后重新做一次完整的 scope 校验(recheck:
 * 重新 realpath,仍须在 scope 内),并要求其结果与 fd 是同一个 inode;通过后只经这个 fd 读。校验之后叶子或某级
 * 目录被换成指向 scope 外的链接 → 复核时路径已在 scope 外(拒绝),或已换回但打开的不是复核到的那个文件
 * (重试,读到的是 scope 内的文件)。复核本身仍按路径,来回换多次的外部竞态者理论上仍可通过(见
 * plugin-fs-rw-lock/README 残余)。正常的并发原子保存(inode 换新)也会造成不一致,所以重试一次再拒绝。
 */
async function readFileVerified(
  canonical: string,
  recheck: () => Promise<string>,
  opts: ReadFileOptions = {},
): Promise<{ canonical: string; content: string }> {
  for (let attempt = 0; ; attempt++) {
    let fh: FileHandle;
    try {
      fh = await openForReadNonBlocking(canonical);
    } catch (err) {
      throw fsError(mapNodeErrnoCode(err), `readFile failed: ${canonical}`);
    }
    try {
      const opened = await fh.stat({ bigint: true });
      const now = await fs.stat(await recheck(), { bigint: true });
      if (opened.dev === now.dev && opened.ino === now.ino) {
        return { canonical, content: await readFileFromHandle(fh, canonical, opts) };
      }
    } finally {
      await fh.close().catch(() => {});
    }
    if (attempt >= 1) throw new ScopeError('target changed during access', { target: canonical });
    canonical = await recheck();
  }
}

export async function canonicalizePathScopes(
  scopes: readonly PathScope[],
): Promise<PathScope[]> {
  const canonicalScopes = new Array<PathScope>(scopes.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= scopes.length) return;
      const scope = scopes[i]!;
      canonicalScopes[i] = {
        path: await canonicalizeScopePath(scope.path),
        mode: scope.mode,
      };
    }
  };
  const workerCount = Math.min(CANONICALIZE_SCOPE_CONCURRENCY, scopes.length);
  const workers = new Array<Promise<void>>(workerCount);
  for (let i = 0; i < workerCount; i++) {
    workers[i] = worker();
  }
  await Promise.all(workers);
  return canonicalScopes;
}

export function registerPluginFsHandlers(
  ipcMain: IpcMain,
  deps: PluginFsDeps,
): void {
  const { identityRegistry, pathScopeRegistry, correlator } = deps;
  // 安全:所有 fs 操作的 target 先过层级数上限,再进 path-scope 校验。registry.check 已限长度(FS_PATH_MAX),但
  // `/a/a/a/…` 8190 字符可以有 4000 多级,而校验里逐级处理(逐级找最近的已存在上级、逐级 stat 取文件身份)的开销
  // 随层级数增长。真实路径到不了 FS_PATH_MAX_DEPTH;超出与超长同样按畸形 target 拒绝(不碰文件系统、不回显路径)。
  const checkScope = ((token, senderId, opType, target, mode) => {
    if (typeof target === 'string' && pathDepthExceeds(target, FS_PATH_MAX_DEPTH)) {
      return Promise.reject(new ScopeError('invalid target path', { reason: 'target-invalid' }));
    }
    return pathScopeRegistry.check(token, senderId, opType as 'read', target, mode);
  }) as PathScopeRegistry['check'];
  // 大块读取闸的名额键:token 所属插件的 pluginId(同一插件各窗口 / 各实例共享)。未知 token 归入 '' 桶
  //('' 不是合法 pluginId),随后的 scope 校验照常拒绝。
  const heavyReadKey = (token: unknown): string =>
    (typeof token === 'string' ? identityRegistry.lookup(token)?.pluginId : undefined) ?? '';
  const sharedHeavy =
    <E, A extends unknown[], R>(fn: (event: E, token: string, ...args: A) => Promise<R>) =>
    (event: E, token: string, ...args: A): Promise<R> =>
      heavyRead(heavyReadKey(token), () => fn(event, token, ...args));
  const maybeSweepStaleTrash = createTrashSweepThrottle();
  const scopeThrottle = new ScopeRequestThrottle();
  // 关窗(destroyed)/ renderer reload(主框架非同文档导航)时释放该 webContents 名下的身份 token 与
  // pending scope 授权请求:两种情况都不会有 renderer 主动发的 _unregister-plugin,此前 token 永驻
  // entries;reload 前发起的授权请求也要干等满 TTL(关窗另有 releaseWindowResources 兜底,幂等)。
  // 时序:导航开始即撤旧,新文档脚本的重新注册在其后,不会被误撤。path-scope 按 pluginId 全局共享
  //(其它窗口同插件仍在用、且有持久化),不在此撤。
  const attachWcGoneHook = makeWcGoneHook((wcId) => {
    identityRegistry.revokeByWebContents(wcId);
    correlator.cancelBySender(wcId);
    unpinPluginOpenedPathsOf(wcId);
  });

  ipcMain.handle(
    PLUGIN_FS_CHANNELS.REGISTER_PLUGIN,
    async (event, pluginId: unknown) => {
      // 边界(E97):pluginId 来自 renderer,裸 register 绕过 manifest id 正则 + E86/E87 持久化
      // canonicalize 前门。超长/非法 id 会经 request-scope/persist/broadcast 携带 → 主进程 Map
      // 长期驻留 + 路径 scope 持久化键污染 + IPC payload 放大。注册入口复用插件 id 规则
      //(isSafePluginId,形态规则见 electron/shared/plugin-id)+ 长度上限;非法固定 BAD_INPUT,不进 registry。
      if (
        typeof pluginId !== 'string' ||
        !isSafePluginId(pluginId)
      ) {
        throw fsError(ERROR_CODES.BAD_INPUT, 'invalid pluginId');
      }
      attachWcGoneHook(event.sender);
      return identityRegistry.register(pluginId, event.sender.id);
    },
  );

  ipcMain.handle(PLUGIN_FS_CHANNELS.UNREGISTER_PLUGIN, async (_event, token: string) => {
    // 撤 path-scope 必须在 revoke 之前 lookup(revoke 进 drain 但 lookup 仍能查到;
    // 这里先取 pluginId/generation 再撤,语义更清晰)。与 identity token 撤销对称:
    // 否则插件卸载/禁用后授予的 scope 永久驻留,同 id 重装直接继承(审计 #2)。
    const info = identityRegistry.lookup(token);
    identityRegistry.revoke(token);
    // 该实例的未决 scope 请求一并收口(释放插件的单飞名额;handler 会通知 renderer 撤掉弹窗)。
    correlator.cancelByToken(token);
    // generation 守卫:仅当没有更新实例已注册(generation 仍是最新)时才撤,
    // 避免 HMR reload 先 register 新实例后再 unregister 旧 token 时,
    // 误删新实例已 grant 的 scope。
    if (
      info &&
      identityRegistry.currentGeneration(info.pluginId) === info.generation
    ) {
      pathScopeRegistry.revokeAll(info.pluginId);
    }
  });

  ipcMain.handle(
    PLUGIN_FS_CHANNELS.READ_FILE,
    sharedHeavy(async (event, token: string, target: string) => {
      const recheck = async (): Promise<string> =>
        (await checkScope(token, event.sender.id, 'read', target, 'r')).canonical;
      // 边界(E28,E18 平行入口):scope 校验后直接 fs.readFile(.., 'utf-8') 无大小上限,
      // 已授权插件可让主进程整块读入超大文件再经 IPC 回 renderer → 内存峰值/卡死。复用主
      // fs:read-file 的 readFile(E18:读前 stat.size,超 64MiB 抛 FS_FILE_TOO_LARGE +
      // 目录守卫 + errno 映射),单一来源,与 write-file 复用 atomicWriteFile(R4)同手法。
      return (await readFileVerified(await recheck(), recheck)).content;
    }),
  );

  // editor.openFile(插件发起):校验与读取在同一次持锁内完成,返回已校验的内容与 canonical 路径;renderer 用
  // 这份内容开标签。读取规则与编辑器自己的读取入口(fs:read-file)一致:64MiB 上限、非法 UTF-8 拒绝、非普通
  // 文件拒绝。scope 拒绝 / FS_* 错误以结果对象返回(renderer 映射成 openFile 的结果码);身份错误照抛。
  ipcMain.handle(
    PLUGIN_FS_CHANNELS.READ_FOR_EDITOR,
    async (event, token: string, target: string): Promise<PluginFsEditorRead> => {
      const recheck = async (): Promise<string> =>
        (await checkScope(token, event.sender.id, 'read', target, 'r')).canonical;
      try {
        const read = await heavyRead(heavyReadKey(token), async () => readFileVerified(await recheck(), recheck, { requireUtf8: true }));
        // 读取已过 scope 校验(token 有效);lookup 落空只可能是 token 恰好被回收,归入 '' 桶。
        if (!pinPluginOpenedPath(read.canonical, event.sender.id, identityRegistry.lookup(token)?.pluginId ?? '')) {
          console.warn('[plugin-fs] read-for-editor refused: too many plugin-opened editor tabs');
          return {
            ok: false,
            code: ERROR_CODES.FS_BUSY,
            message: `too many files opened by plugins (max ${PLUGIN_OPENED_PATHS_PER_PLUGIN_MAX} per plugin, ${PLUGIN_OPENED_PATHS_MAX} in total); close some editor tabs`,
          };
        }
        return { ok: true, canonicalPath: read.canonical, content: read.content };
      } catch (err) {
        if (err instanceof ScopeError) {
          return { ok: false, code: PLUGIN_FS_EDITOR_READ_SCOPE_DENIED, message: 'path out of granted scope' };
        }
        const code = (err as { code?: unknown } | null)?.code;
        if (typeof code === 'string' && code.startsWith('FS_')) {
          return { ok: false, code, message: errorMessage(err) };
        }
        throw err;
      }
    },
  );

  // 宿主编辑器释放 read-for-editor 记下的一份(标签关闭 / 未新建标签)。不取锁:只改内存记录。只释放发起窗口自己的。
  ipcMain.handle(PLUGIN_FS_CHANNELS.RELEASE_EDITOR_PATH, (event, path: unknown) => {
    if (typeof path !== 'string' || path.length > FS_PATH_MAX) return;
    unpinPluginOpenedPath(path, event.sender.id);
  });

  ipcMain.handle(
    PLUGIN_FS_CHANNELS.WRITE_FILE,
    exclusive(async (event, token: string, target: string, content: string) => {
      const r = await checkScope(
        token,
        event.sender.id,
        'write',
        target,
        'rw',
      );
      // 边界(E29,E13 平行入口):content 此前无大小上限直接进 atomicWriteFile。已授权插件可经
      // 单次 IPC 发超大字符串 → 主进程 IPC 内存峰值 + 超大临时文件 + fsync/rename 长时间阻塞。复用
      // 主 fs:write-file 的 MAX_WRITE_BYTES(64MiB,按真实 UTF-8 字节,与主入口一致),进 atomicWriteFile
      // 前拒绝超限并抛 FS_FILE_TOO_LARGE(与 E28 读侧 twin 同错误码)。是 read-file E28 的写侧对偶。
      // 边界(E125):真实 UTF-8 字节(非 .length=UTF-16 code unit),与主 fs:write-file 同款。
      if (utf8BytesExceed(content, MAX_WRITE_BYTES)) {
        throw fsError(
          ERROR_CODES.FS_FILE_TOO_LARGE,
          `content 超过上限 ${MAX_WRITE_BYTES} 字节`,
        );
      }
      // crash-safe 原子写:裸 fs.writeFile 默认以 'w' 打开先 truncate,写入中途
      // ENOSPC/崩溃/掉电/进程被杀会把用户文件留成空/半截且无法回滚。复用 Explorer
      // fs:write-file 同款 atomicWriteFile(写同目录 tmp + fsync + rename 原子替换 +
      // per-path 串行),与主仓既有 crash-safe 写入语义(Explorer/autosave/plugin-data
      // atomicWriteJson)对齐。(复审 loop R4:plugin-fs 平行入口漏了原子写保护)
      //
      // 安全(符号链接写穿):必须用**不跟随叶子链接**的写入器。上面的 check('write') 已 lstat 叶子并拒绝链接,
      // 但编辑器保存用的 atomicWriteFile 会再 lstat 一次并 realpath 跟随链接(读写对称)。两次 lstat 之间叶子可被
      // 换成链接:scope 内有一条指向 scope 外的链接 `link` 时,并发 rename(link → x) 与 writeFile(x) 即把内容写到
      // scope 外(实测 5000 次竞态约 250 次命中)。no-follow 版本的 rename(tmp → fullPath) 替换的是路径本身
      //(此刻是链接就替换掉链接),tmp 以 'wx' 排他创建也不跟随。校验与写入的跟随策略一致,且都作用在校验得到的
      // 父目录 realpath + 叶子名上。兄弟入口 fs.ipc 的 writeBinaryHandler 出于同一理由用它。
      // 父目录的某一级在校验之后被换成链接(Node 无 openat,写入会跟到新位置):插件自己的变更调用被 fsLock
      // 挡在本次调用之外;锁管不到的外部改动是残余(见 fsLock 注释),本文件所有写操作同此。
      await atomicReplaceFileNoFollow(r.fullPath, content);
    }),
  );

  ipcMain.handle(PLUGIN_FS_CHANNELS.LIST_DIR, sharedHeavy(async (event, token: string, target: string) => {
    const r = await checkScope(
      token,
      event.sender.id,
      'read',
      target,
      'r',
    );
    // 边界(E30,plugin-fs 平行入口):此前 fs.readdir 整目录后全量 map 返回,无条目数上限。
    // 已授权插件对超大目录调 listDir 会让主进程一次性构造巨大数组并经 IPC 全量返回 → 内存/CPU/
    // IPC 卡顿。用 opendir 惰性迭代(不先把全部 Dirent 物化进内存),累计到硬上限即 fail-closed
    // 抛 FS_DIR_TOO_LARGE(不静默截断 —— 截断会让插件误判「文件不存在」)。上限 100k 是滥用
    // backstop:单层目录 >10 万直接子项极罕见,远超任何现实插件目录。
    const out: {
      name: string;
      isFile: boolean;
      isDirectory: boolean;
      isSymlink: boolean;
    }[] = [];
    const dir = await fs.opendir(r.canonical);
    for await (const e of dir) {
      if (out.length >= MAX_LIST_DIR_ENTRIES) {
        // for-await 在抛出时调用迭代器 return() 自动关闭 dir,无句柄泄漏。
        throw fsError(
          ERROR_CODES.FS_DIR_TOO_LARGE,
          `directory has too many entries (> ${MAX_LIST_DIR_ENTRIES})`,
        );
      }
      out[out.length] = {
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        isSymlink: e.isSymbolicLink(),
      };
    }
    return out;
  }));

  ipcMain.handle(PLUGIN_FS_CHANNELS.STAT, shared(async (event, token: string, target: string) => {
    const r = await checkScope(
      token,
      event.sender.id,
      'read',
      target,
      'r',
    );
    return statPayload(await fs.stat(r.canonical));
  }));

  ipcMain.handle(PLUGIN_FS_CHANNELS.LSTAT, shared(async (event, token: string, target: string) => {
    const r = await checkScope(
      token,
      event.sender.id,
      'lstat',
      target,
      'r',
    );
    return statPayload(await fs.lstat(r.fullPath));
  }));

  ipcMain.handle(
    PLUGIN_FS_CHANNELS.REALPATH,
    shared(async (event, token: string, target: string) => {
      const r = await checkScope(
        token,
        event.sender.id,
        'read',
        target,
        'r',
      );
      return r.canonical;
    }),
  );

  ipcMain.handle(
    PLUGIN_FS_CHANNELS.MKDIR,
    exclusive(async (
      event,
      token: string,
      target: string,
      opts?: { recursive?: boolean },
    ) => {
      const r = await checkScope(
        token,
        event.sender.id,
        'mkdir',
        target,
        'rw',
      );
      await fs.mkdir(r.fullPath, { recursive: opts?.recursive ?? false });
    }),
  );

  ipcMain.handle(
    PLUGIN_FS_CHANNELS.RENAME,
    exclusive(async (event, token: string, src: string, dst: string) => {
      // 'rename-src' 走不跟随 leaf 解析:移动的是链接本身而非 realpath 跟随后的目标。
      const rSrc = await checkScope(
        token,
        event.sender.id,
        'rename-src',
        src,
        'rw',
      );
      const rDst = await checkScope(
        token,
        event.sender.id,
        'rename-dst',
        dst,
        'rw',
      );
      const srcPath = rSrc.fullPath;
      if (dirname(srcPath) !== rDst.parentCanonical) {
        throw new ScopeError('rename: same-parent enforced', { target: dst });
      }
      // 拒绝静默覆盖已存在目标:POSIX rename(2) 原子覆盖既有文件 → 不防御则插件在
      // 授权目录内把 a 改成已存在 b 的名字会永久丢失 b 的内容。镜像 Explorer
      // renameEntry(electron/main/ipc/fs/rename.ts)早有的 inode 比较守卫 —— 仅当目标
      // 存在且与源不是同一 inode 时拒,大小写改名到自身(同 inode 且名字只差大小写/规范化)放行;
      // 同 inode 的不同硬链接仍拒(POSIX rename 对其是 no-op 却返回成功)。显式覆盖走
      // atomicReplaceWithinScope({overwrite:true}),普通 rename 保持非覆盖语义。
      // (复审 loop R2:plugin-fs 平行入口漏了 Explorer 的 FS_EEXIST 守卫)
      // 只有 ENOENT(不存在)才正常改名;EACCES/EIO 等「无法确认目标」不能 fail-open(否则 rename
      // 静默覆盖已有目标,P1 同族)→ lstatOrNull 抛出中止。
      const dstStat = await lstatOrNull(rDst.fullPath);
      if (dstStat) {
        let srcStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
        try {
          srcStat = await fs.lstat(srcPath);
        } catch {
          srcStat = null;
        }
        const sameEntry =
          srcStat != null &&
          dstStat.ino === srcStat.ino &&
          dstStat.dev === srcStat.dev &&
          isCaseOrNormalizationOnlyRename(srcPath, rDst.fullPath);
        if (!sameEntry) {
          throw new ScopeError('rename: destination already exists', {
            target: dst,
            reason: 'EEXIST',
          });
        }
      }
      await fs.rename(srcPath, rDst.fullPath);
    }),
  );

  ipcMain.handle(
    PLUGIN_FS_CHANNELS.RM,
    exclusive(async (
      event,
      token: string,
      target: string,
      opts?: { recursive?: boolean; force?: boolean },
    ) => {
      // 'remove' 走不跟随 leaf 解析:删的是链接本身而非 realpath 跟随后的目标数据。
      const r = await checkScope(
        token,
        event.sender.id,
        'remove',
        target,
        'rw',
      );
      await fs.rm(r.fullPath, {
        recursive: opts?.recursive ?? false,
        force: opts?.force ?? false,
      });
    }),
  );

  ipcMain.handle(
    PLUGIN_FS_CHANNELS.CP,
    exclusive(async (
      event,
      token: string,
      src: string,
      dst: string,
      opts?: { recursive?: boolean },
    ) => {
      // 'read-tree':递归复制会进入源的整棵子树,子树含受保护根(应用自身目录)时拒绝。
      const rSrc = await checkScope(
        token,
        event.sender.id,
        'read-tree',
        src,
        'r',
      );
      const rDst = await checkScope(
        token,
        event.sender.id,
        'write',
        dst,
        'rw',
      );
      // 拒绝静默覆盖已存在目标:Node fs.cp 默认 force:true,目标存在即覆盖 → 插件普通
      // copy 会丢用户已有文件。与 R2 的 rename 守卫对称(普通 cp 保持非覆盖语义,显式
      // 覆盖走 atomicReplaceWithinScope({overwrite:true}))。(复审 loop R3:cp 是
      // R2 rename 的兄弟方法,同族「防御未传播到平行入口」)
      // 只有 ENOENT 才正常复制;其它 lstat 错误不 fail-open(同 rename 守卫)。cp 自身已
      // force:false+errorOnExist 兜底,此处提前抛出更清晰一致。
      const cpDstStat = await lstatOrNull(rDst.fullPath);
      if (cpDstStat) {
        throw new ScopeError('copy: destination already exists', {
          target: dst,
          reason: 'EEXIST',
        });
      }
      // force:false + errorOnExist:true 关闭 lstat→cp 之间的 TOCTOU 窗口:fs.cp 默认
      // force:true 会击穿 errorOnExist(实测仅 force:false 时生效),目标若在 lstat 后被
      // 并发创建仍会静默覆盖。前置 lstat 保留只为更早给出友好的 ScopeError。
      //
      // 安全(符号链接写穿,同 WRITE_FILE):fs.cp 自己对目标是 lstat(链接算「已存在」→ EEXIST),但它的检查与
      // 落盘的 copyFile 之间目标仍可被换成指向 scope 外的链接,而 copyFile 默认跟随目标链接。COPYFILE_EXCL 让
      // 目标以 O_EXCL 创建:此刻已存在任何条目(含链接、悬空链接)即 EEXIST,不跟随。非覆盖语义下它对合法复制无影响。
      // fs.cp 按路径递归:期间目录结构不被插件改动由独占锁保证。filter 只用来数条目(含根),超限中止。
      let entries = 0;
      try {
        await fs.cp(rSrc.canonical, rDst.fullPath, {
          recursive: opts?.recursive ?? false,
          force: false,
          errorOnExist: true,
          mode: fsConstants.COPYFILE_EXCL,
          filter: () => {
            entries += 1;
            if (entries > MAX_CP_ENTRIES) {
              throw fsError(ERROR_CODES.FS_DIR_TOO_LARGE, `copy has too many entries (> ${MAX_CP_ENTRIES})`);
            }
            return true;
          },
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ERR_FS_CP_EEXIST' || code === 'EEXIST') {
          throw new ScopeError('copy: destination already exists', {
            target: dst,
            reason: 'EEXIST',
          });
        }
        throw err;
      }
    }),
  );

  ipcMain.handle(
    PLUGIN_FS_CHANNELS.READ_GIT_BLOB,
    sharedHeavy(async (event, token: string, repoDir: string, rawSha: string) => {
      // 边界(E63):sha 进 git cat-file argv 前先校验固定 hex 形态 + 长度(挡超长 sha 触发 spawn
      // E2BIG / argv 内存放大;非 hex 也直接拒,绝不进 spawn)。只认完整 sha,不做唯一前缀解析。
      if (!isValidGitBlobSha(rawSha)) {
        throw new ScopeError('invalid git blob sha (must be a full 40- or 64-char hex sha)', {
          target: typeof rawSha === 'string' ? rawSha.slice(0, 64) : 'non-string',
        });
      }
      // 安全:hex 允许 A-F,而 git 内部转小写后才找对象(objects/ab/…)。按原样的大写前缀校验扇出目录时,大小写
      // 敏感文件系统上 objects/AB 不存在(跳过校验),git 实际读的 objects/ab 若是外链就读到 scope 外。统一转小写。
      const sha = rawSha.toLowerCase();
      const senderId = event.sender.id;
      const r = await checkScope(token, senderId, 'read', repoDir, 'r');
      const cwd = r.canonical;
      // 安全:repoDir 在 scope 内不代表 git 读的对象库在 scope 内(见 resolveGitObjectStoreInScope)。
      const pin = await resolveGitObjectStoreInScope(
        cwd,
        sha,
        async (p) => (await checkScope(token, senderId, 'read', p, 'r')).canonical,
      );
      return readGitBlob(cwd, sha, { pin });
    }),
  );

  ipcMain.handle(
    PLUGIN_FS_CHANNELS.ATOMIC_REPLACE,
    exclusive(async (
      event,
      token: string,
      staging: string,
      final: string,
      opts?: { overwrite?: boolean },
    ) => {
      const rStaging = await checkScope(
        token,
        event.sender.id,
        'rename-dst',
        staging,
        'rw',
      );
      const rFinal = await checkScope(
        token,
        event.sender.id,
        'rename-dst',
        final,
        'rw',
      );
      if (rStaging.parentCanonical !== rFinal.parentCanonical) {
        throw new ScopeError('atomicReplace: staging/final must share parent', {
          target: final,
        });
      }
      if (rStaging.fullPath === rFinal.fullPath) {
        throw new ScopeError('atomicReplace: staging and final must differ', {
          target: final,
        });
      }
      // 安全:宿主会在 final 的父目录里放 trash(旧 final 的暂存落点)并清扫过期 trash,所以父目录自身必须落在
      // 该插件的某条 rw scope 内。'rename-dst' 对「final 等于 scope 根」放行,此时父目录已在 scope 外 —— 此前
      // 照样清扫它,等于替插件递归删掉 scope 外的旧 `.trash-*`。在任何文件系统变更之前拒绝。
      try {
        await checkScope(token, event.sender.id, 'read', rFinal.parentCanonical, 'rw');
      } catch (err) {
        if (!(err instanceof ScopeError)) throw err;
        throw new ScopeError('atomicReplace: parent directory must be inside a granted rw scope', {
          target: final,
        });
      }
      await maybeSweepStaleTrash(rFinal.parentCanonical); // perf:按目录节流,见 createTrashSweepThrottle
      await atomicReplacePaths(rStaging.fullPath, rFinal.fullPath, final, opts);
    }),
  );

  ipcMain.handle(PLUGIN_FS_CHANNELS.USER_HOME, async (event, token: string) => {
    identityRegistry.resolve(token, event.sender.id);
    return homedir();
  });

  ipcMain.handle(
    PLUGIN_FS_CHANNELS.REQUEST_SCOPE,
    async (event, token: string, scopes: readonly PathScope[]) => {
      const { pluginId } = identityRegistry.resolve(token, event.sender.id);
      // 安全:请求期间该插件的 scope 被整体撤销(撤销 fs / 卸载)→ 这个请求作废:不弹窗、不落地。撤销时已挂着的弹窗
      // 由撤销方结算(correlator.cancelByToken);这里挡的是撤销落在本处理器 await 间隙(归一化 / 水合读盘 / 冷却键)
      // 里的请求 —— 否则撤销之后照样弹出新窗,用户一点「授权」scope 就落地并持久化。
      const revocationEpoch = pathScopeRegistry.revocationEpoch(pluginId);
      const revokedMeanwhile = (): boolean => pathScopeRegistry.revocationEpoch(pluginId) !== revocationEpoch;

      // 边界(E31):scopes 是插件直传的 IPC payload,此前无运行时校验就批量 canonicalize
      // (realpath)+ 原样发 renderer 弹窗 + 可能进 registry/persist。畸形插件可传超大数组/
      // 超长路径/非法 mode → 主进程批量 realpath、大 IPC payload、弹窗渲染卡顿;非法 mode 还污染
      // 后续授权匹配语义。入口 fail-closed 校验数量/路径长度/mode 枚举,超限直接拒绝(不进
      // canonicalize/弹窗/持久化)。其余 IPC 入口校验同族:E11/E12/E16/E17/E23。
      // 边界(E31/E239):共享 helper 校验(数量 + 每项 path/mode),与 renderer scoped-app 同一来源。
      const scopesErr = validateScopesShape(scopes);
      if (scopesErr) {
        throw fsError(ERROR_CODES.BAD_INPUT, scopesErr);
      }

      // 归一化请求 scope 到与 registry 内存同一空间(expandHome + realpath),供覆盖
      // 判定与落地复用。否则 `~/...` 或含符号链接组件的根授予后永不匹配 → scope 静默
      // 死掉,插件所有 fs 操作误拒。canonicalizeScopePath 对不存在路径 fail-safe(回退
      // 展开值,不抛),故提前到弹窗前归一化是安全的。
      const canonicalScopes = await canonicalizePathScopes(scopes);

      // 安全(受保护根):请求的 scope 根在应用自身目录内(或就是它)→ 直接 deny,不弹窗、不计入节流,也不被
      // 已有的更宽授权静默覆盖成 grant(即使授予,check 也会拒绝其下一切访问)。包含受保护根的更宽 scope
      //(如 `~`)照常弹窗:用户的意图是授予 home,受保护子树由 check 保证不可达。原因只进主进程日志。
      const protectedScope = canonicalScopes.find((s) => pathScopeRegistry.isProtectedPath(s.path));
      if (protectedScope) {
        console.warn(
          `[plugin-fs] ${pluginId} requestScope denied without prompt: inside a protected app directory: ${protectedScope.path}`,
        );
        return 'deny';
      }

      // 冷启动水合:首次见到该 plugin 时,把上次会话已授 scope 从磁盘回填进 registry,
      // 使重启后对同一目录的 requestScope 直接命中 covers() 而不再弹窗。读盘失败也标记
      // 已水合,避免每个请求重复打盘。
      if (deps.loadPersistedScopes && !pathScopeRegistry.isHydrated(pluginId)) {
        try {
          const persisted = await deps.loadPersistedScopes(pluginId);
          // 读盘挂起期间插件可能已卸载(token 撤销 + revokeAll 清内存):此时 persisted 是卸载清盘前
          // 的旧快照,水合会把旧 scope 写回内存并置 hydrated → 同 id 重装静默继承。token 非 active 不水合。
          if (identityRegistry.isActive(token)) pathScopeRegistry.hydrate(pluginId, persisted);
        } catch {
          if (identityRegistry.isActive(token)) pathScopeRegistry.hydrate(pluginId, []);
        }
      }
      if (revokedMeanwhile()) return 'deny';

      // 已被现有授权(本会话 grant 或已水合的持久化授权)覆盖 → 静默授予,免重复弹窗。
      // 这是「持久化方案」省去重启后重复授权的关键路径。
      if (pathScopeRegistry.covers(pluginId, canonicalScopes)) {
        // 登记插件请求时的写法(如经符号链接的路径),之后用同一写法访问才能通过 check 的词法预判。
        pathScopeRegistry.noteRequestedRoots(pluginId, scopes, canonicalScopes);
        return 'grant';
      }

      // 先做不依赖冷却键的廉价判定:未决数到顶、该插件已有未决弹窗 / 在退避期 / 弹窗超速 → 直接 deny。算冷却键要
      // 逐级 stat(下一步),被节流的请求不该再触发这份开销(此前 scopeThrottleKeys 在任何节流判定之前,插件可以
      // 不受限地反复触发)。下面 canAccept / tryPrompt 仍照常判一次(权威;await 期间状态可能变化)。
      if (!correlator.canAccept(event.sender.id) || scopeThrottle.blockedRegardlessOfKeys(pluginId)) {
        return 'deny';
      }

      // 冷却键带文件身份(路径别名换个写法不能避开冷却)。要 stat,放在 canAccept 之前:canAccept → tryPrompt →
      // createRequest 之间保持同步,不让并发请求在中间插进来。
      const throttleKey = await scopeThrottleKeys(canonicalScopes.map((s) => s.path));

      // 边界(E227):未决 scope 请求数到顶(全局/单窗口)→ 终态 deny 收口,不入 pending、不向 renderer
      // 发弹窗。插件 spam request-scope 否则让主进程 pending Map / renderer 弹窗队列 / TTL 定时器线性增长。
      if (!correlator.canAccept(event.sender.id) || revokedMeanwhile()) {
        return 'deny';
      }
      // 安全:每插件单飞 + 拒绝冷却(按单条路径)+ 插件级连续被拒退避 + 每插件弹窗速率上限(见
      // scope-request-throttle)。该插件已有未决弹窗、请求里有刚被用户拒绝的路径(或其祖先)、或该插件连续被拒 /
      // 弹窗过于频繁 → 直接 deny,不发弹窗:插件不能同步连发、或在拒绝回调里循环 requestScope(换个组合 / mode /
      // 父目录再问)诱导误点。
      if (!scopeThrottle.tryPrompt(pluginId, throttleKey)) {
        return 'deny';
      }
      // tryPrompt 放行即占用该插件的单飞名额:弹窗无论怎样收口(用户决定 / TTL / 关窗 / 插件注销 / 发送失败 /
      // 任何异常)都必须释放,漏一条该插件就再也请求不了 scope —— 统一放 finally。
      let decision: 'grant' | 'deny';
      try {
        const { requestId, promise } = correlator.createRequest(token, event.sender.id);
        // race(R73,agent-auth R62 同族):createRequest 登记 pending 后、send 前 sender 可能销毁
        // (renderer reload/关窗),send 抛 "Object has been destroyed"。下方 try 只裹 `await promise`,
        // 不裹这次 send;若 send 裸抛,该 pending 会泄漏到 5min TTL 才被 sweep —— 插件侧
        // requestScope() 一直挂着,且用户从未看到授权弹窗(发送失败),形成「授权请求假死」。send 包
        // try/catch:失败时立即 cancelBySender 清掉本 sender 的 pending(sender 已死),按终态 deny
        // 收口。promise.catch 吞掉 cancel 触发的 reject,避免 unhandled rejection(此处不再 await 它)。
        try {
          // displayPath:弹窗展示用户实际授予的路径(`~` 已展开、符号链接已解析,与下方 grant 落地同源)。
          // sandbox renderer 没有 process,自己展开不了 `~`。
          event.sender.send(PLUGIN_FS_CHANNELS.SCOPE_REQUEST, {
            requestId,
            pluginId,
            scopes: scopes.map((s, i) => {
              const displayPath = canonicalScopes[i]!.path;
              // 展开后超长 → 不带(renderer 守卫会把超长 displayPath 判畸形并丢弃整个请求),回退显示原始 path。
              return displayPath.length <= FS_PATH_MAX
                ? { path: s.path, mode: s.mode, displayPath }
                : { path: s.path, mode: s.mode };
            }),
          });
        } catch {
          promise.catch(() => undefined);
          correlator.cancelBySender(event.sender.id);
          return 'deny';
        }
        try {
          decision = await promise;
        } catch (err) {
          // 窗口硬关闭会经 cancelScopeRequestsForWebContents → correlator.cancelBySender
          // reject 该 pending(ScopeRequestTimeoutError 'window closed')。此时等待的
          // renderer 已随窗口销毁,reply 无处可送;若任由 reject 冒泡,Electron 会记成
          // "Error occurred in handler for 'plugin-fs:request-scope'" 噪声。sender 已销毁
          // → 视为终态 deny 静默收口(不 grant)。renderer 仍存活的 TTL 超时仍按原契约
          // reject,让 renderer 的 requestScope() 抛出。
          if (err instanceof ScopeRequestTimeoutError) {
            if (event.sender.isDestroyed()) return 'deny';
            // renderer 还在而请求已在 main 侧收口(TTL / 插件注销):让它撤掉弹窗,否则弹窗滞留,用户点了才发现
            // 决定送不出去。
            try {
              event.sender.send(PLUGIN_FS_CHANNELS.SCOPE_REQUEST_CANCELLED, { requestId });
            } catch {
              // sender 恰好销毁:无弹窗可撤
            }
            // 插件实例已注销(卸载 / 禁用 / reload):不是错误,也不是用户的拒绝(不记入冷却)。
            if (err.message === SCOPE_REQUEST_PLUGIN_UNREGISTERED) return 'deny';
          }
          throw err;
        }
      } finally {
        scopeThrottle.endPrompt(pluginId);
      }
      scopeThrottle.noteDecision(pluginId, throttleKey, decision);
      // 弹窗挂起期间插件可能被卸载/禁用(_unregister-plugin → revoke token,token
      // 进 5s drain;lookup/resolve 仍能查到所以无法区分)。落地 grant 前重校验 token
      // 仍 active,否则会复活已撤销插件的 path-scope,同 id 重装直接继承(绕过
      // _unregister-plugin 的 revokeAll 守卫,审计 #2 同源)。见第十三轮 P2-AJ。
      if (decision === 'grant' && identityRegistry.isActive(token) && !revokedMeanwhile()) {
        pathScopeRegistry.grant(pluginId, canonicalScopes);
        pathScopeRegistry.noteRequestedRoots(pluginId, scopes, canonicalScopes);
        // 持久化合并后的全集,供下次启动水合;best-effort,失败不影响本次授权。
        if (deps.persistScopes) {
          try {
            await deps.persistScopes(
              pluginId,
              pathScopeRegistry.getScopes(pluginId),
            );
          } catch {
            // ignore persist failure: 本会话已 grant,仅下次重启会回退到弹窗。
          }
        }
      }
      return decision;
    },
  );

  ipcMain.handle(
    PLUGIN_FS_CHANNELS.SCOPE_DECISION,
    async (event, requestId: unknown, decision: unknown): Promise<void> => {
      // 边界(E96):requestId/decision 来自 renderer,裸 handle 无 schema 校验。超长 requestId 会被
      // 塞进 ScopeRequestTimeoutError 经 IPC reject/log/toast 链路放大;非法 decision 命中 pending
      // 会 resolve 成非预期值,破坏授权决策契约。入口 fail-closed:requestId 非空且 ≤ 上限、decision
      // 须 enum;非法抛 BAD_INPUT(固定文案,不把原始 requestId 拼进错误)。
      if (
        typeof requestId !== 'string' ||
        requestId.length === 0 ||
        requestId.length > SCOPE_REQUEST_ID_MAX
      ) {
        throw fsError(ERROR_CODES.BAD_INPUT, 'invalid scope-decision requestId');
      }
      if (decision !== 'grant' && decision !== 'deny') {
        throw fsError(ERROR_CODES.BAD_INPUT, 'invalid scope-decision value');
      }
      correlator.resolve(requestId, decision, event.sender.id);
    },
  );

}

// trash 名的唯一来源:`.trash-<原 basename>-<13 位毫秒时间戳>-<4 位 base36>`。生成(trashUniqueSuffix /
// trashPathFor)与清扫的识别(parseTrashTimestamp)共用 TRASH_PREFIX 与下面两个常量,不会各写一份而漂移。
const TRASH_TS_DIGITS = 13;
const TRASH_RAND_LEN = 4;
const TRASH_SUFFIX_RE = new RegExp(`-(\\d{${TRASH_TS_DIGITS}})-[0-9a-z]{${TRASH_RAND_LEN}}$`);

/** 本次替换的 trash 唯一后缀:`<毫秒时间戳>-<4 位 base36>`(随机段不足 4 位时补 0,保证形态固定)。 */
function trashUniqueSuffix(): string {
  const rand = Math.random().toString(36).slice(2, 2 + TRASH_RAND_LEN).padEnd(TRASH_RAND_LEN, '0');
  return `${Date.now()}-${rand}`;
}

/** 条目名是宿主生成形态的 trash → 返回名字里的时间戳(移入 trash 的时刻);否则 null。 */
function parseTrashTimestamp(name: string): number | null {
  if (!name.startsWith(TRASH_PREFIX)) return null;
  const m = TRASH_SUFFIX_RE.exec(name);
  // m.index 是后缀起点:必须在前缀之后还留有非空的原 basename。
  return m && m.index > TRASH_PREFIX.length ? Number(m[1]) : null;
}

/**
 * 构造可被 sweepStaleTrashInDir 回收的 trash 兄弟路径。三条不变量:
 *   1. basename 以 TRASH_PREFIX 开头、以 trashUniqueSuffix 的形态结尾—— sweep 只认
 *      这一形态。旧实现用 `${finalPath}.trash-...`(后缀形式 `foo.json.trash-...`)永远匹配不上,
 *      rename 回滚失败时泄漏的 trash 永久驻留(审计 49 follow-up)。
 *   2. 与 finalPath 同父目录 —— 原子 rename 要求同设备。
 *   3. 保留原 basename 便于排障。
 */
export function trashPathFor(finalPath: string, unique: string): string {
  return join(
    dirname(finalPath),
    `${TRASH_PREFIX}${basename(finalPath)}-${unique}`,
  );
}

async function atomicReplacePaths(
  stagingPath: string,
  finalPath: string,
  finalTarget: string,
  opts?: { overwrite?: boolean },
): Promise<void> {
  let finalExists = false;
  try {
    await fs.access(finalPath);
    finalExists = true;
  } catch (err) {
    // 只有 ENOENT 才是「不存在」。EACCES/EIO/ELOOP 等「无法确认目标状态」不能 fail-open
    // (否则走无覆盖分支 rename 仍可能替换实际存在的 final,绕过 overwrite:false 契约 —
    // 与 rename/move/cp fail-closed 守卫一致,P1)。抛出中止 replace。
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!finalExists) {
    try {
      await fs.rename(stagingPath, finalPath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        throw new ScopeError('cross-device rename not allowed', {
          target: finalTarget,
        });
      }
      throw err;
    }
  }
  if (!opts?.overwrite) {
    throw new ScopeError('final exists, overwrite not requested', {
      target: finalTarget,
    });
  }

  const trashPath = trashPathFor(finalPath, trashUniqueSuffix());
  let renamed = false;
  for (let i = 0; i < 3 && !renamed; i++) {
    try {
      await fs.rename(finalPath, trashPath);
      renamed = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' || i === 2) throw err;
      await new Promise((resolve) =>
        setTimeout(resolve, [100, 300, 1000][i]),
      );
    }
  }

  try {
    await fs.rename(stagingPath, finalPath);
  } catch (err) {
    try {
      await fs.rename(trashPath, finalPath);
    } catch (rollbackErr) {
      // 数据安全:回滚也失败 → 旧 final 只剩 trash 里这一份,且过期清扫 24 小时后会删掉它。把 trash 路径交给
      // 插件(它本就在该插件的 rw scope 内,给完整路径不泄露 scope 外信息)并记主进程日志;错误码沿用原始失败。
      // IPC 只传 message,故写进 message 而不是附加字段。
      console.error(
        `[plugin-fs] atomicReplace rollback failed; previous final preserved at ${trashPath}`,
        rollbackErr,
      );
      const original = err as NodeJS.ErrnoException;
      const reported: NodeJS.ErrnoException = new Error(
        `${original?.message ?? String(err)}; rollback failed, the previous contents of final are preserved at ${trashPath} (reclaimed after 24h — move it back to recover)`,
        { cause: err },
      );
      if (original?.code !== undefined) reported.code = original.code;
      throw reported;
    }
    throw err;
  }
  try {
    await fs.rm(trashPath, { recursive: true, force: true });
  } catch {
    // best effort cleanup only
  }
}

// perf:ATOMIC_REPLACE 此前每次替换前无条件 sweep(整目录 readdir + 逐个 stat .trash-*)—— 插件以原子替换做
// 自动保存、目标目录条目很多时,每次保存都 O(N)。sweep 只回收 >TRASH_TTL_MS(24h)的泄漏 trash(rename
// 回滚失败 / 崩溃残留),不是替换的正确性前置:trash 名含时间戳+随机后缀,不依赖目录先被清空防撞名。
// 改为按 canonical parent 节流:同一目录 TRASH_SWEEP_INTERVAL_MS 内只扫一次(相对 24h TTL,仅延后回收)。
// 跟踪表按插入序淘汰,容量上限防随访问过的目录数单调增长。
const TRASH_SWEEP_INTERVAL_MS = 60_000;
const TRASH_SWEEP_TRACK_MAX = 256;

export function createTrashSweepThrottle(
  now: () => number = Date.now,
  maxTracked: number = TRASH_SWEEP_TRACK_MAX,
): (dir: string) => Promise<void> {
  const lastSweepAt = new Map<string, number>();
  return async (dir) => {
    const t = now();
    const last = lastSweepAt.get(dir);
    // t < last(时钟回拨)→ 视为到期,不被卡死。
    if (last !== undefined && t >= last && t - last < TRASH_SWEEP_INTERVAL_MS) return;
    lastSweepAt.delete(dir); // 重新插入到末尾(最近使用)
    if (lastSweepAt.size >= maxTracked) {
      const oldest = lastSweepAt.keys().next().value;
      if (oldest !== undefined) lastSweepAt.delete(oldest);
    }
    lastSweepAt.set(dir, t); // 先记再扫:并发替换不重复扫
    await sweepStaleTrashInDir(dir);
  };
}

/**
 * 回收 dir 里过期(>TRASH_TTL_MS)的宿主 trash。Best-effort。调用方保证 dir 在插件的 rw scope 内。
 *
 * 安全:只认 trashPathFor 生成的精确形态 —— 用户 / 其它工具自己命名的 `.trash-*` 一律不动(此前只看前缀 +
 * mtime 就 `rm -rf`)。过期须同时满足:名字里的时间戳(移入 trash 的时刻)与条目自身的 mtime 都早于 cutoff。
 * 只看 mtime 不够:目录改名不更新自身 mtime,刚移入 trash 的旧目录会被并发的另一次清扫当场删掉,替换失败时
 * 无从回滚。用 lstat(不跟随):名字被换成符号链接时按链接自身判定;fs.rm 对链接只删链接本身。
 * 清扫范围是该目录下全部宿主形态的 trash(不限本次目标同名):只扫同名的话,之后再没被替换过的目标
 * 泄漏的 trash 永远没人回收。
 */
export async function sweepStaleTrashInDir(
  dir: string,
): Promise<{ swept: number; failed: number }> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { swept: 0, failed: 0 };
  }

  let swept = 0;
  let failed = 0;
  const cutoff = Date.now() - TRASH_TTL_MS;
  for (const entry of entries) {
    const trashedAt = parseTrashTimestamp(entry.name);
    if (trashedAt === null || trashedAt >= cutoff) continue;
    const full = join(dir, entry.name);
    try {
      const s = await fs.lstat(full);
      if (s.mtimeMs < cutoff) {
        await fs.rm(full, { recursive: true, force: true });
        swept++;
      }
    } catch {
      failed++;
    }
  }
  return { swept, failed };
}
