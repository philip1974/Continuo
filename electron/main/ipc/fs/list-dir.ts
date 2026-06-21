import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry } from '../../../shared/fs-entry';
import { ERROR_CODES } from '../../../shared/error-codes';
import { fsError, mapNodeErrnoCode } from './path-utils';

const MAX_DEPTH_HARD_LIMIT = 10;

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
  const exclude = opts.exclude ?? DEFAULT_EXCLUDE;
  const followSymlinks = opts.followSymlinks ?? false;
  const maxFiles =
    opts.maxFiles && opts.maxFiles > 0 ? opts.maxFiles : Infinity;

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
  const state = { fileCount: 0 };
  return walk(dirPath, 1, maxDepth, exclude, followSymlinks, maxFiles, state);
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
  // followSymlinks=true 时按目标判 isDirectory(但仍记 isSymlink:true 以便 UI 区分)
  if (isSymlink && followSymlinks) {
    try {
      const targetSt = await lstat(full); // 简化:不递归 link 目标(保持历史行为)
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
  exclude: readonly string[],
  followSymlinks: boolean,
  maxFiles: number,
  state: { fileCount: number },
): Promise<FileEntry[]> {
  if (state.fileCount >= maxFiles) return []; // cap 后进入的子树:不 readdir/lstat
  const dirents = await readdir(dir, { withFileTypes: true });
  const candidates = dirents.filter((d) => !exclude.includes(d.name));
  const out: FileEntry[] = [];

  // 按块并发 lstat(Promise.all 保留块内顺序),块间检查 cap。组装、计数、递归
  // 仍按 candidates 顺序逐项进行 —— 输出与历史串行版逐字节一致;递归保持串行,
  // 避免共享 state.fileCount 的并发竞态(maxFiles 语义确定)。
  for (let i = 0; i < candidates.length; i += LSTAT_CHUNK) {
    if (state.fileCount >= maxFiles) break;
    const chunk = candidates.slice(i, i + LSTAT_CHUNK);
    const resolved = await Promise.all(
      chunk.map((d) => resolveEntry(dir, d, followSymlinks)),
    );
    for (const item of resolved) {
      if (state.fileCount >= maxFiles) break; // 文件数已达上限 → 停止
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
          state,
        );
        out.push(...children);
      }
    }
  }

  return sortDirsFirst(out);
}

function sortDirsFirst(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
