import { LIST_DIR_MAX_DEPTH, LIST_DIR_TOTAL_ENTRIES_MAX } from '../../../shared/fs-limits';
import { lstat, opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry } from '../../../shared/fs-entry';
import { ERROR_CODES } from '../../../shared/error-codes';
import { fsError, mapNodeErrnoCode } from './path-utils';
import { direntTypeIsReliable } from '../../lib/dirent-real-type';
import { LIST_DIR_DEFAULT_EXCLUDE } from '../../../shared/fs-limits';
import { compareFileNames } from '../../../shared/compare-file-names';
import { readFileCappedFd } from '../../lib/read-fh-capped';
import ignore, { type Ignore } from 'ignore';

const MAX_DEPTH_HARD_LIMIT = LIST_DIR_MAX_DEPTH;

// 边界(E38,plugin-fs E30 主侧 twin):maxFiles 是可选业务上限(只数文件、达标早停返部分,QuickOpen
// 用)。但默认 Infinity,Explorer/open-recent/drop 不传 maxFiles → 列超宽目录时 readdir+lstat+sort+
// IPC 返回完整巨大数组,主进程与 renderer 同时高内存/CPU 甚至卡死。加总条目硬上限(文件+目录都计数)
// 作滥用 backstop,默认启用;超过即 fail-closed 抛 FS_DIR_TOO_LARGE(同 plugin-fs E30,不静默截断 —
// Explorer 静默截断会让用户误判文件缺失)。单层目录 >10 万直接子项极罕见,远超任何现实目录;QuickOpen
// 的 maxFiles(更低)在此之前早停,不会触发本上限。
// 边界(E275):值定义在 shared(listDir IPC schema 的 maxFiles 上界对齐到此硬上限)。
export const MAX_TOTAL_ENTRIES = LIST_DIR_TOTAL_ENTRIES_MAX;

const DEFAULT_EXCLUDE_SET: ReadonlySet<string> = new Set(LIST_DIR_DEFAULT_EXCLUDE);

export interface ListDirOptions {
  /** 默认 1(只列当前层)。受 MAX_DEPTH_HARD_LIMIT(= LIST_DIR_MAX_DEPTH)截断。 */
  readonly maxDepth?: number;
  /** basename 黑名单。默认见 LIST_DIR_DEFAULT_EXCLUDE,自定义完全替换默认。 */
  readonly exclude?: readonly string[];
  /**
   * 性能(perf 审计 P2):**文件数**上限。收集到这么多文件即停止遍历与递归
   * (目录不计入)。默认无限。给 Quick Open 这类「只要前 N 个候选」的深递归用,
   * 避免大 monorepo 每次 ⌘P 都扫完整棵树 + lstat + IPC 全量传输。
   * 注:仅在文件数真的超过上限时才改变结果;未达上限时输出与不传完全一致。
   */
  readonly maxFiles?: number;
  /**
   * 边界(E38):总条目(文件+目录)硬上限,默认 MAX_TOTAL_ENTRIES。超过即抛 FS_DIR_TOO_LARGE。
   * 仅供进程内调用方调低(及测试);**不在 listDirInputSchema 暴露**,renderer 无法绕过 backstop。
   */
  readonly maxTotalEntries?: number;
  /**
   * 性能(Quick Open ⌘P):默认 true。为 false 时不返回 size/mtime/ctime,类型直接取自 opendir 的
   * dirent(isFile/isDirectory/isSymbolicLink),普通文件/目录/符号链接不再逐项 lstat;仅 dirent 类型
   * 未知(三者皆 false,如部分文件系统返回 DT_UNKNOWN)及 win32 上 dirent 报 symlink(libuv 把所有
   * reparse point 报成链接,见 resolveEntry)回退 lstat。
   * maxFiles 计数口径与 withStats:true 一致(dirent.isFile() ≡ lstat().isFile())。
   * 差异仅一处:readdir 与 lstat 之间被删的项,withStats:true 跳过,false 仍列出(本就是竞态快照)。
   */
  readonly withStats?: boolean;
  /**
   * 递归扫描时遵从忽略文件(VSCode search.useIgnoreFiles,默认开 —— ripgrep 读 `.gitignore` 与 `.ignore`):每层目录的
   * `.gitignore` / `.ignore` 按 gitignore 语法(否定 `!`、目录 `/`、`**`、锚定 `/`)作用于该目录之下,深层的规则覆盖浅层,同一目录
   * `.ignore` 覆盖 `.gitignore`;被忽略的目录不再下钻。不读工作区根之上的忽略文件(VSCode search.useParentIgnoreFiles 默认关),
   * 不要求是 git 仓库(VSCode 给 ripgrep 传 --no-require-git)。缺省 false(资源管理器逐层列目录不受影响)。
   */
  readonly useIgnoreFiles?: boolean;
}

/**
 * 列目录。借鉴 Lokus read_directory_contents_with_depth:深度上限 + 黑名单 + symlink 防御。
 *
 * 排序:目录优先,再按 compareFileNames(数字段按数值,对齐 VSCode 资源管理器默认排序)。
 */
export async function listDir(
  dirPath: string,
  opts: ListDirOptions = {},
): Promise<FileEntry[]> {
  return (await scanDir(dirPath, opts)).entries;
}

/** scanDir 结果:条目 + 递归中因读不了而跳过的子目录数。 */
export interface ScanDirResult {
  readonly entries: FileEntry[];
  /**
   * 递归扫描(maxDepth > 1)时,子目录 opendir / 读取 / 子项 lstat 失败(EACCES / EPERM / ENAMETOOLONG / ELOOP / EIO 等)
   * 被整棵跳过的个数(对齐 VSCode:ripgrep 遇到读不了的目录只报到输出通道、照常给其余结果)。根目录本身读不了仍抛错。
   */
  readonly skippedDirs: number;
}

/**
 * 同 listDir,另报跳过的子目录数(Quick Open / 在文件中查找据此提示「已跳过 N 个无法读取的目录」)。
 * 只有根(调用方给的 dirPath)失败才抛;子目录失败跳过该子树并计数,不让一个不可读目录让整次扫描失败。
 */
export async function scanDir(
  dirPath: string,
  opts: ListDirOptions = {},
): Promise<ScanDirResult> {
  const requested = opts.maxDepth ?? 1;
  const maxDepth = Math.min(Math.max(requested, 1), MAX_DEPTH_HARD_LIMIT);
  // 边界(E21,perf):exclude 转 Set,大目录下每个目录项的排除判断从 O(N) includes 降为 O(1) has
  // (巨大 exclude 列表 × 宽目录 = 线性放大;schema 已 cap exclude ≤1000,Set 进一步消除热路径开销)。
  const exclude =
    opts.exclude === undefined ? DEFAULT_EXCLUDE_SET : new Set(opts.exclude);
  const withStats = opts.withStats ?? true;
  // 边界(E275,clamp 非有限/不安全整数族):maxFiles 经 IPC schema(已加 .max(MAX_TOTAL_ENTRIES))进来,
  // 但 list-dir 作为内部 helper 须自守(防 schema 旁路/不安全整数 1e308 仍过 z.int())。要求安全正整数,
  // 并 clamp 到 MAX_TOTAL_ENTRIES(超过无意义:总条目本就在此硬上限早停);非法 → Infinity(走默认硬上限)。
  const rawMaxFiles = opts.maxFiles;
  const maxFiles =
    typeof rawMaxFiles === 'number' &&
    Number.isSafeInteger(rawMaxFiles) &&
    rawMaxFiles > 0
      ? Math.min(rawMaxFiles, MAX_TOTAL_ENTRIES)
      : Infinity;
  const maxTotalEntries =
    opts.maxTotalEntries && opts.maxTotalEntries > 0
      ? opts.maxTotalEntries
      : MAX_TOTAL_ENTRIES;

  // 入口用 stat 跟随 symlink — root 是用户显式要的路径,/tmp / /etc 这种
  // macOS 系统 symlink 应被解析。子项用 lstat 才能区分 isSymlink:true。
  let rootStat;
  try {
    rootStat = await stat(dirPath);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `stat failed: ${dirPath}`);
  }
  if (!rootStat.isDirectory()) {
    throw fsError(ERROR_CODES.FS_NOT_DIRECTORY, `not a directory: ${dirPath}`);
  }

  // 共享文件计数:达到 maxFiles 即停止遍历/递归。maxFiles=Infinity(默认)时
  // 守卫永不触发,walk 行为与历史逐字节一致。
  const state: WalkState = { fileCount: 0, totalCount: 0, skippedDirs: 0 };
  const entries = await walk(
    dirPath,
    1,
    maxDepth,
    exclude,
    withStats,
    maxFiles,
    maxTotalEntries,
    state,
    opts.useIgnoreFiles === true && maxDepth > 1 ? NO_IGNORE_LAYERS : null,
  );
  return { entries, skippedDirs: state.skippedDirs };
}

interface WalkState {
  fileCount: number;
  totalCount: number;
  skippedDirs: number;
}

/** 某目录下忽略文件的规则(作用于 base 之下的路径)。 */
interface IgnoreLayer {
  readonly base: string;
  readonly ig: Ignore;
}

const NO_IGNORE_LAYERS: readonly IgnoreLayer[] = [];
/** 同一目录内后加的规则优先:ripgrep 的 `.ignore` 优先于 `.gitignore`。 */
const IGNORE_FILE_NAMES = ['.gitignore', '.ignore'] as const;
/** 忽略文件读取上限(超过视作无规则;防异常大文件拖慢扫描)。 */
const IGNORE_FILE_MAX_BYTES = 1024 * 1024;

/** 遵从忽略文件时,本层先缓存这么多条目再定规则(见 walk)。 */
const IGNORE_PROBE_BUFFER = 1024;

/** 读 dir 下的忽略文件 names(按 IGNORE_FILE_NAMES 顺序);都没有(或读不了 / 过大)→ null。 */
async function loadIgnoreLayer(dir: string, names: readonly string[]): Promise<IgnoreLayer | null> {
  const ordered = IGNORE_FILE_NAMES.filter((n) => names.includes(n));
  const texts = await Promise.all(
    ordered.map((name) =>
      readFileCappedFd(path.join(dir, name), IGNORE_FILE_MAX_BYTES).then(
        (r) => r.text,
        () => null, // 不存在 / 是目录 / 无权限:没有规则
      ),
    ),
  );
  let ig: Ignore | null = null;
  for (const text of texts) {
    if (text) (ig ??= ignore({ ignorecase: false })).add(text.replace(/^\uFEFF/, '')); // ripgrep 默认区分大小写;去 BOM
  }
  return ig === null ? null : { base: dir, ig };
}

/** git 语义:由浅到深逐层判定,深层的「忽略 / 取消忽略(!)」覆盖浅层的结论。 */
function isIgnoredByLayers(layers: readonly IgnoreLayer[], full: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const layer of layers) {
    let rel = path.relative(layer.base, full);
    if (path.sep !== '/') rel = rel.split(path.sep).join('/');
    if (isDirectory) rel += '/';
    try {
      const r = layer.ig.test(rel);
      if (r.ignored) ignored = true;
      else if (r.unignored) ignored = false;
    } catch {
      // ignore 包拒绝的路径形态(理论上不会出现):按未忽略处理
    }
  }
  return ignored;
}

function isFsDirTooLarge(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === ERROR_CODES.FS_DIR_TOO_LARGE;
}

/** 已带业务码(FS_*)的错误原样抛;原始 errno 映射成业务码(renderer 按码本地化,不显示原始串)。 */
function toFsError(err: unknown, message: string): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.startsWith('FS_')) return err;
  return fsError(mapNodeErrnoCode(err), message);
}

// perf P3:同一层目录的 lstat 并发度。旧实现 for 循环逐项 `await lstat` 串行,
// 1000 文件目录 ≈ 1000 次 stat 延迟累加(网络盘/外接盘更糟)。改为按块并发
// lstat。块大小同时是 maxFiles 早停的 over-scan 上界:cap 命中的那一块最多多
// lstat (CHUNK-1) 项,远小于「整层一次性并发」会劣化 P2 的代价。
const LSTAT_CHUNK = 32;

interface ResolvedEntry {
  readonly d: { name: string };
  readonly full: string;
  /** withStats:false 时为 null(输出不带 size/mtime/ctime)。 */
  readonly st: import('node:fs').Stats | null;
  readonly isSymlink: boolean;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

type DirEntryLike = {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

// 解析单个 dirent。withStats:false 且 dirent 类型已知 → 直接用 dirent 类型,不 lstat;
// 否则 lstat,失败(边读边删竞态)→ null(跳过)。
// linkTargetType(仅浅层 maxDepth=1,即资源管理器逐层展开):符号链接再 stat 目标,目标是目录则标
// isDirectory:true(VSCode:链接目录显示为可展开文件夹,带链接标记);悬空 / 自环(ENOENT / ELOOP)按文件。
// 递归扫描(Quick Open 等)不做:类型保持 lstat 口径,且 walk 恒不递归进链接(防循环)。
async function resolveEntry(
  dir: string,
  d: DirEntryLike,
  withStats: boolean,
  linkTargetType: boolean,
): Promise<ResolvedEntry | null> {
  const full = path.join(dir, d.name);
  let st: import('node:fs').Stats | null = null;
  let isSymlink: boolean;
  let isDirectory: boolean;
  let isFile: boolean;
  // dirent 类型未知、或 win32 上报 symlink(libuv 把所有 reparse point 报成链接,见 direntTypeIsReliable)
  // 不可采信,回退 lstat(与 withStats:true 口径一致:目录照常递归、文件计入 maxFiles)。
  if (!withStats && direntTypeIsReliable(d)) {
    isSymlink = d.isSymbolicLink();
    isDirectory = d.isDirectory();
    isFile = d.isFile();
  } else {
    let lst;
    try {
      lst = await lstat(full);
    } catch (err) {
      // 目录有读权限、无执行(搜索)权限(如 644):能读出名字,逐项 lstat 全部 EACCES。旧实现当作「边读边删」逐项跳过 →
      // 资源管理器展开后显示为空、没有错误行。权限错误按该目录读取失败上抛(资源管理器显示读取失败行;递归扫描跳过该目录)。
      const code = (err as { code?: unknown }).code;
      if (code === 'EACCES' || code === 'EPERM') throw fsError(ERROR_CODES.FS_DENIED, `lstat failed: ${full}`);
      return null; // 边读边删的竞态(ENOENT)/ 单项名字过长等:跳过该项
    }
    isSymlink = lst.isSymbolicLink();
    isDirectory = lst.isDirectory();
    isFile = lst.isFile();
    if (withStats) st = lst;
  }
  if (isSymlink && linkTargetType) {
    try {
      isDirectory = (await stat(full)).isDirectory();
    } catch {
      isDirectory = false; // 悬空 / 循环链接:按文件显示(仍带 isSymlink)
    }
  }
  return { d, full, st, isSymlink, isDirectory, isFile };
}

function resolveEntryBatch(
  dir: string,
  batch: readonly DirEntryLike[],
  batchCount: number,
  withStats: boolean,
  linkTargetType: boolean,
): Array<Promise<ResolvedEntry | null>> {
  const promises = new Array<Promise<ResolvedEntry | null>>(batchCount);
  for (let i = 0; i < batchCount; i++) {
    promises[i] = resolveEntry(dir, batch[i]!, withStats, linkTargetType);
  }
  return promises;
}

async function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  exclude: ReadonlySet<string>,
  withStats: boolean,
  maxFiles: number,
  maxTotalEntries: number,
  state: WalkState,
  /** 遵从忽略文件时为祖先目录的规则层(由浅到深);null = 不读忽略文件。 */
  ignoreLayers: readonly IgnoreLayer[] | null,
): Promise<FileEntry[]> {
  if (state.fileCount >= maxFiles) return []; // cap 后进入的子树:不 opendir/lstat
  const out: FileEntry[] = [];

  // 边界(E211,E206-E210 有界迭代族):用 opendir 流式读取(Dir 内部 bufferSize 缓冲,默认 ~32),
  // 边读边按 LSTAT_CHUNK 成块处理 —— 不用 readdir 一次性把整目录所有 dirent 物化进主进程数组 + 再
  // filter 物化一份(超宽目录会在 MAX_TOTAL_ENTRIES 检查前内存峰值/OOM)。totalCount 仍在处理阶段
  // 计数(语义/上限不变);for await 在 break/throw/完成时自动 close Dir。
  // 入口 stat 只证明路径存在且是目录;无读权限(EACCES / EPERM)到 opendir 才暴露。原始 errno 映射成业务码
  //(FS_DENIED 等),renderer 按码本地化,不把 `EACCES: permission denied, opendir '<路径>'` 原样显示给用户。
  let dirHandle;
  try {
    dirHandle = await opendir(dir);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `opendir failed: ${dir}`);
  }
  // 本目录的忽略规则(遵从忽略文件时):本层条目先缓存到 IGNORE_PROBE_BUFFER 个 —— 目录在此之内读完(绝大多数)就按读到的名字
  // 判断有没有 .gitignore / .ignore,只读真有的(多数目录一个都没有,免两次 ENOENT 的 open);缓存满了还没读完(超宽目录)
  // 则直接尝试读两个文件。规则确定后再按块处理缓存的条目。
  let layers = ignoreLayers;
  let ownPending = ignoreLayers !== null;
  const buffered: DirEntryLike[] = [];
  const seenIgnoreFiles: string[] = [];
  const resolveOwnLayer = async (names: readonly string[]): Promise<void> => {
    ownPending = false;
    if (names.length === 0) return;
    const own = await loadIgnoreLayer(dir, names);
    if (own !== null) layers = [...ignoreLayers!, own];
  };
  const chunk = new Array<DirEntryLike>(LSTAT_CHUNK);
  let chunkCount = 0;
  let stop = false;
  // 本层文件优先于子目录(Quick Open 第二十四轮):maxFiles 截断时,旧实现边读边深度优先下钻,opendir 顺序里排在前面的
  // 大子目录(如 2 万文件的 huge/)会吃光名额,连根下的文件都进不了候选。改为本层全部条目读完、再按序下钻子目录 ——
  // 未截断时文件集合不变(仅同名项的相对次序随遍历次序变化);截断时浅层文件先入选。下钻时本层 Dir 句柄已关闭。
  const subdirs: string[] = [];

  // 处理一块:并发 lstat(保留块内顺序),逐项组装/计数/递归。stop=true 表示 maxFiles 已达,应停。
  const flushChunk = async (): Promise<void> => {
    if (chunkCount === 0) return;
    const batchCount = chunkCount;
    chunkCount = 0;
    const resolved = await Promise.all(
      resolveEntryBatch(dir, chunk, batchCount, withStats, maxDepth === 1),
    );
    for (const item of resolved) {
      if (state.fileCount >= maxFiles) {
        stop = true;
        break;
      }
      if (!item) continue;
      const { full, st, isSymlink, isDirectory, isFile } = item;
      if (layers !== null && layers.length > 0 && isIgnoredByLayers(layers, full, isDirectory)) continue;
      out[out.length] =
        st === null
          ? {
              path: full,
              name: item.d.name,
              isDirectory,
              ...(isSymlink && { isSymlink: true }),
            }
          : {
              path: full,
              name: item.d.name,
              isDirectory,
              ...(isSymlink && { isSymlink: true }),
              ...(isFile && { size: st.size }),
              mtime: st.mtimeMs,
              ctime: st.ctimeMs,
            };
      if (isFile) state.fileCount++; // 只文件计入 maxFiles(目录不计)
      // 边界(E38):总条目(文件+目录)硬上限,超过即 fail-closed 抛(滥用/极端目录 backstop,
      // 不静默截断)。与只数文件的业务 maxFiles 正交;QuickOpen 的 maxFiles 更低会先早停。
      state.totalCount++;
      if (state.totalCount > maxTotalEntries) {
        throw fsError(
          ERROR_CODES.FS_DIR_TOO_LARGE,
          `directory tree has too many entries (> ${maxTotalEntries})`,
        );
      }

      // 递归:目录、未达深度、且不是 symlink(不跟随链接:递归扫描的链接目录不展开,防循环)。
      // 先记下,本层读完再下钻(见下方 subdirs)。
      if (isDirectory && depth < maxDepth && !isSymlink) subdirs[subdirs.length] = full;
    }
  };

  // 一项进块,满 LSTAT_CHUNK 即处理(抛 FS_DIR_TOO_LARGE 时 for await 经迭代器 return() 关闭 Dir)。
  const add = async (dirent: DirEntryLike): Promise<void> => {
    chunk[chunkCount] = dirent; // 保留 dirent 类型(withStats:false 免 lstat)
    chunkCount += 1;
    if (chunkCount >= LSTAT_CHUNK) await flushChunk();
  };
  const drainBuffered = async (): Promise<void> => {
    for (const d of buffered) {
      if (stop) break;
      await add(d);
    }
    buffered.length = 0;
  };

  // for await 流式遍历:非排除项累积到 LSTAT_CHUNK 即成块处理;break/throw/完成自动 close Dir。
  // 读目录项中途失败(EIO 等)同 opendir 失败映射成业务码。
  try {
    for await (const dirent of dirHandle) {
      if (state.fileCount >= maxFiles) break;
      if (exclude.has(dirent.name)) continue;
      if (ownPending) {
        if ((IGNORE_FILE_NAMES as readonly string[]).includes(dirent.name)) seenIgnoreFiles.push(dirent.name);
        buffered.push(dirent);
        if (buffered.length < IGNORE_PROBE_BUFFER) continue;
        await resolveOwnLayer(IGNORE_FILE_NAMES); // 超宽目录:名字还没读全,两个都试
        await drainBuffered();
        if (stop) break;
        continue;
      }
      await add(dirent);
      if (stop) break;
    }
    if (ownPending) {
      await resolveOwnLayer(seenIgnoreFiles);
      await drainBuffered();
    }
    // 处理流末尾的残块(for await 正常结束时 Dir 已自动关闭;flushChunk 不依赖 Dir 句柄)。
    if (!stop) await flushChunk();
  } catch (err) {
    throw toFsError(err, `readdir failed: ${dir}`);
  }

  for (const sub of subdirs) {
    if (state.fileCount >= maxFiles) break;
    // 子目录读不了(无权限 / 路径超长 / I/O 错误…)只跳过该子树并计数,不让整次递归扫描失败(VSCode / ripgrep 同)。
    // 计数回滚到进入前:被丢弃子树里已计入的文件 / 条目不占 maxFiles 与总条目名额。总条目超限照旧整体抛(滥用 backstop)。
    const before = { fileCount: state.fileCount, totalCount: state.totalCount, skippedDirs: state.skippedDirs };
    let children: FileEntry[];
    try {
      children = await walk(sub, depth + 1, maxDepth, exclude, withStats, maxFiles, maxTotalEntries, state, layers);
    } catch (err) {
      if (isFsDirTooLarge(err)) throw err;
      state.fileCount = before.fileCount;
      state.totalCount = before.totalCount;
      state.skippedDirs = before.skippedDirs + 1;
      continue;
    }
    for (let i = 0; i < children.length; i++) {
      out[out.length] = children[i]!;
    }
  }

  return sortDirsFirst(out);
}

export function sortDirsFirst(entries: FileEntry[]): FileEntry[] {
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const cur = entries[i]!;
    if (prev.isDirectory !== cur.isDirectory) {
      if (!prev.isDirectory) return entries.sort(compareDirsFirst);
      continue;
    }
    if (compareFileNames(prev.name, cur.name) > 0) {
      return entries.sort(compareDirsFirst);
    }
  }
  return entries;
}

function compareDirsFirst(a: FileEntry, b: FileEntry): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return compareFileNames(a.name, b.name);
}
