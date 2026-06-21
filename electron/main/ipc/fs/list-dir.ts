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

async function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  exclude: readonly string[],
  followSymlinks: boolean,
  maxFiles: number,
  state: { fileCount: number },
): Promise<FileEntry[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const out: FileEntry[] = [];

  for (const d of dirents) {
    if (state.fileCount >= maxFiles) break; // 文件数已达上限 → 停止
    if (exclude.includes(d.name)) continue;
    const full = path.join(dir, d.name);

    // 用 lstat 判 symlink(readdir 的 dirent 在某些 fs 上 isSymbolicLink 不可靠)
    let st;
    try {
      st = await lstat(full);
    } catch {
      continue; // 边读边删的竞态:跳过
    }

    const isSymlink = st.isSymbolicLink();
    let isDirectory = st.isDirectory();

    // followSymlinks=true 时按目标判 isDirectory(但仍记 isSymlink:true 以便 UI 区分)
    if (isSymlink && followSymlinks) {
      try {
        const targetSt = await lstat(full); // 简化:不递归 link 目标
        isDirectory = targetSt.isDirectory();
      } catch {
        /* link 失效,按原 lstat 处理 */
      }
    }

    out.push({
      path: full,
      name: d.name,
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

  return sortDirsFirst(out);
}

function sortDirsFirst(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
