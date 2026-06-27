import { lstat, opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry } from '../../../shared/fs-entry';
import { ERROR_CODES } from '../../../shared/error-codes';
import { fsError, mapNodeErrnoCode } from './path-utils';

const MAX_DEPTH_HARD_LIMIT = 10;

// 边界(E38,plugin-fs E30 主侧 twin):maxFiles 是可选业务上限(只数文件、达标早停返部分,QuickOpen
// 用)。但默认 Infinity,Explorer/open-recent/drop 不传 maxFiles → 列超宽目录时 readdir+lstat+sort+
// IPC 返回完整巨大数组,主进程与 renderer 同时高内存/CPU 甚至卡死。加总条目硬上限(文件+目录都计数)
// 作滥用 backstop,默认启用;超过即 fail-closed 抛 FS_DIR_TOO_LARGE(同 plugin-fs E30,不静默截断 —
// Explorer 静默截断会让用户误判文件缺失)。单层目录 >10 万直接子项极罕见,远超任何现实目录;QuickOpen
// 的 maxFiles(更低)在此之前早停,不会触发本上限。
// 边界(E275):导出供 fs.ipc.ts 的 listDir schema 把 maxFiles 上界对齐到此硬上限。
export const MAX_TOTAL_ENTRIES = 100_000;

const DEFAULT_EXCLUDE: readonly string[] = [
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
];

export interface ListDirOptions {
  /** 默认 1(只列当前层)。受 MAX_DEPTH_HARD_LIMIT=10 截断。 */
  readonly maxDepth?: number;
  /** basename 黑名单。默认见 DEFAULT_EXCLUDE,自定义完全替换默认。 */
  readonly exclude?: readonly string[];
  /** 默认 false:用 lstat,symlink 不递归。 */
  readonly followSymlinks?: boolean;
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
}

/**
 * 列目录。借鉴 Lokus read_directory_contents_with_depth:深度上限 + 黑名单 + symlink 防御。
 *
 * 排序:目录优先,再按 localeCompare(borrows from Lokus)。
 */
export async function listDir(
  dirPath: string,
  opts: ListDirOptions = {},
): Promise<FileEntry[]> {
  const requested = opts.maxDepth ?? 1;
  const maxDepth = Math.min(Math.max(requested, 1), MAX_DEPTH_HARD_LIMIT);
  // 边界(E21,perf):exclude 转 Set,大目录下每个目录项的排除判断从 O(N) includes 降为 O(1) has
  // (巨大 exclude 列表 × 宽目录 = 线性放大;schema 已 cap exclude ≤1000,Set 进一步消除热路径开销)。
  const exclude = new Set(opts.exclude ?? DEFAULT_EXCLUDE);
  const followSymlinks = opts.followSymlinks ?? false;
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
  const state = { fileCount: 0, totalCount: 0 };
  return walk(
    dirPath,
    1,
    maxDepth,
    exclude,
    followSymlinks,
    maxFiles,
    maxTotalEntries,
    state,
  );
}

// perf P3:同一层目录的 lstat 并发度。旧实现 for 循环逐项 `await lstat` 串行,
// 1000 文件目录 ≈ 1000 次 stat 延迟累加(网络盘/外接盘更糟)。改为按块并发
// lstat。块大小同时是 maxFiles 早停的 over-scan 上界:cap 命中的那一块最多多
// lstat (CHUNK-1) 项,远小于「整层一次性并发」会劣化 P2 的代价。
const LSTAT_CHUNK = 32;

interface ResolvedEntry {
  readonly d: { name: string };
  readonly full: string;
  readonly st: import('node:fs').Stats;
  readonly isSymlink: boolean;
  readonly isDirectory: boolean;
}

// 解析单个 dirent 的 stat。lstat 失败(边读边删竞态)→ null(跳过)。
async function resolveEntry(
  dir: string,
  d: { name: string },
  followSymlinks: boolean,
): Promise<ResolvedEntry | null> {
  const full = path.join(dir, d.name);
  let st;
  try {
    st = await lstat(full);
  } catch {
    return null; // 边读边删的竞态:跳过
  }
  const isSymlink = st.isSymbolicLink();
  let isDirectory = st.isDirectory();
  // followSymlinks=true 时按**目标**判 isDirectory(但仍记 isSymlink:true 以便 UI 区分)。
  // 必须用 stat(跟随 link)而非 lstat —— 旧实现误用 lstat 拿到的仍是链接本身,
  // symlink-to-directory 永远 isDirectory=false → 不递归 → 静默漏掉链接目录下的文件
  // (codex 复查 P2,自相矛盾于本注释承诺)。symlink 环由 walk 的 MAX_DEPTH_HARD_LIMIT 界定。
  if (isSymlink && followSymlinks) {
    try {
      const targetSt = await stat(full); // 跟随到 link 目标读其真实类型
      isDirectory = targetSt.isDirectory();
    } catch {
      /* link 失效,按原 lstat 处理 */
    }
  }
  return { d, full, st, isSymlink, isDirectory };
}

async function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  exclude: ReadonlySet<string>,
  followSymlinks: boolean,
  maxFiles: number,
  maxTotalEntries: number,
  state: { fileCount: number; totalCount: number },
): Promise<FileEntry[]> {
  if (state.fileCount >= maxFiles) return []; // cap 后进入的子树:不 opendir/lstat
  const out: FileEntry[] = [];

  // 边界(E211,E206-E210 有界迭代族):用 opendir 流式读取(Dir 内部 bufferSize 缓冲,默认 ~32),
  // 边读边按 LSTAT_CHUNK 成块处理 —— 不用 readdir 一次性把整目录所有 dirent 物化进主进程数组 + 再
  // filter 物化一份(超宽目录会在 MAX_TOTAL_ENTRIES 检查前内存峰值/OOM)。totalCount 仍在处理阶段
  // 计数(语义/上限不变);for await 在 break/throw/完成时自动 close Dir。
  const dirHandle = await opendir(dir);
  let chunk: { name: string }[] = [];
  let stop = false;

  // 处理一块:并发 lstat(保留块内顺序),逐项组装/计数/递归。stop=true 表示 maxFiles 已达,应停。
  const flushChunk = async (): Promise<void> => {
    if (chunk.length === 0) return;
    const batch = chunk;
    chunk = [];
    const resolved = await Promise.all(
      batch.map((d) => resolveEntry(dir, d, followSymlinks)),
    );
    for (const item of resolved) {
      if (state.fileCount >= maxFiles) {
        stop = true;
        break;
      }
      if (!item) continue;
      const { full, st, isSymlink, isDirectory } = item;
      out.push({
        path: full,
        name: item.d.name,
        isDirectory,
        ...(isSymlink && { isSymlink: true }),
        ...(st.isFile() && { size: st.size }),
        mtime: st.mtimeMs,
        ctime: st.ctimeMs,
      });
      if (st.isFile()) state.fileCount++; // 只文件计入 maxFiles(目录不计)
      // 边界(E38):总条目(文件+目录)硬上限,超过即 fail-closed 抛(滥用/极端目录 backstop,
      // 不静默截断)。与只数文件的业务 maxFiles 正交;QuickOpen 的 maxFiles 更低会先早停。
      state.totalCount++;
      if (state.totalCount > maxTotalEntries) {
        throw fsError(
          ERROR_CODES.FS_DIR_TOO_LARGE,
          `directory tree has too many entries (> ${maxTotalEntries})`,
        );
      }

      // 递归:目录、未达深度、且不是 symlink(除非 followSymlinks)
      const shouldRecurse =
        isDirectory && depth < maxDepth && (followSymlinks || !isSymlink);
      if (shouldRecurse) {
        const children = await walk(
          full,
          depth + 1,
          maxDepth,
          exclude,
          followSymlinks,
          maxFiles,
          maxTotalEntries,
          state,
        );
        out.push(...children);
      }
    }
  };

  // for await 流式遍历:非排除项累积到 LSTAT_CHUNK 即成块处理;break/throw/完成自动 close Dir。
  for await (const dirent of dirHandle) {
    if (state.fileCount >= maxFiles) break;
    if (exclude.has(dirent.name)) continue;
    chunk.push({ name: dirent.name });
    if (chunk.length >= LSTAT_CHUNK) {
      await flushChunk(); // 抛 FS_DIR_TOO_LARGE 时 for await 经迭代器 return() 关闭 Dir
      if (stop) break;
    }
  }
  // 处理流末尾的残块(for await 正常结束时 Dir 已自动关闭;flushChunk 不依赖 Dir 句柄)。
  if (!stop) await flushChunk();

  return sortDirsFirst(out);
}

function sortDirsFirst(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
