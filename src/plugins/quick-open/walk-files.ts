// Quick Open 文件扫描(纯函数)。
//
// 调注入的 listDir(fs:scan-files)拉 workspace 全量文件,过滤目录,slice 上限,转 relPath;读不了的子目录由 main 跳过并计数
// (skippedDirs,Modal 提示「已跳过 N 个无法读取的目录」),根读不了才失败。
// 不缓存(每次 ⌘P 重 walk 是策略 b — 简单,大 workspace 第一次稍慢但够用)。
//
// BDD: src/__tests__/quick-open/walk-files.spec.ts

import type { FsScanFilesData } from '../../../electron/shared/fs-entry';
import type { IpcFail, IpcOk, IpcResult } from '../../../electron/shared/ipc-result';
import { QUICK_OPEN_MAX_FILES, type QuickOpenFile } from './store';
import { stripRootPrefix } from '@/lib/path-cross';
import { LIST_DIR_MAX_DEPTH, WORKSPACE_SCAN_EXCLUDE } from '../../../electron/shared/fs-limits';

const DEFAULT_MAX_FILES = QUICK_OPEN_MAX_FILES;
// 搜全工作区(VSCode 同款,无业务深度限制):取 list-dir 的递归硬上限。此前写死 8 层,第 9 层起的文件不进
// 候选(截图审计:8 层目录下的长文件名 .ts 搜「ts」搜不到)。扫描量仍由 maxFiles(QUICK_OPEN_MAX_FILES)与总条目上限约束。
const DEFAULT_MAX_DEPTH = LIST_DIR_MAX_DEPTH;
const EMPTY_QUICK_OPEN_FILES: readonly QuickOpenFile[] = [];

// listDir 默认排除 + 常见构建产物 / 缓存目录;与「在文件中查找」同一来源(WORKSPACE_SCAN_EXCLUDE)。
const FULL_EXCLUDE = WORKSPACE_SCAN_EXCLUDE;

function buildExcludeList(extraExclude: readonly string[] | undefined): readonly string[] {
  if (!extraExclude || extraExclude.length === 0) return FULL_EXCLUDE;
  const exclude = new Array<string>(FULL_EXCLUDE.length + extraExclude.length);
  let count = 0;
  for (const item of FULL_EXCLUDE) exclude[count++] = item;
  for (const item of extraExclude) exclude[count++] = item;
  return exclude;
}

export type ListDirFn = (
  path: string,
  options?: {
    maxDepth?: number;
    exclude?: readonly string[];
    maxFiles?: number;
    withStats?: boolean;
  },
) => Promise<IpcResult<FsScanFilesData>>;

export interface WalkOptions {
  /** workspace 根. 空 → fail WORKSPACE_NOT_OPEN. */
  readonly rootPath: string;
  readonly listDir: ListDirFn;
  /** 默认 QUICK_OPEN_MAX_FILES. */
  readonly maxFiles?: number;
  /** 追加到 FULL_EXCLUDE 后面的额外 ignore basename. */
  readonly extraExclude?: readonly string[];
}

/** data = 候选文件;skippedDirs = 扫描时因无法读取(无权限 / 路径超长等)整棵跳过的子目录数(缺省 0)。 */
export type WalkResult = (IpcOk<readonly QuickOpenFile[]> & { readonly skippedDirs?: number }) | IpcFail;

/**
 * 遍历 workspace 文件,只返文件(不要目录),按 listDir 自带顺序保留。
 */
export async function walkWorkspaceFiles(
  opts: WalkOptions,
): Promise<WalkResult> {
  const { rootPath, listDir } = opts;
  if (!rootPath) {
    return {
      ok: false,
      code: 'WORKSPACE_NOT_OPEN',
      message: '尚未打开工作区',
    };
  }
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  if (!(maxFiles > 0)) return { ok: true, data: EMPTY_QUICK_OPEN_FILES };
  const exclude = buildExcludeList(opts.extraExclude);

  // perf P2:把 maxFiles 下推到 main 侧 walker,使其收集够 maxFiles 个文件即停止
  // 遍历(不再扫完整棵树 + lstat + IPC 全量)。下面的 renderer 端 break 仍保留为
  // 防御性二次上限(main 已截断,通常不触发)。
  const r = await listDir(rootPath, {
    maxDepth: DEFAULT_MAX_DEPTH,
    exclude,
    maxFiles,
    // 性能:只用 path/name/isDirectory,不要 size/mtime/ctime → main 免逐项 lstat。
    withStats: false,
  });
  if (!r.ok) return r;
  const { entries, skippedDirs } = r.data;
  if (entries.length === 0) return { ok: true, data: EMPTY_QUICK_OPEN_FILES, ...(skippedDirs > 0 && { skippedDirs }) };

  // 分隔符无关地剥 rootPath 前缀 → 复用单一来源 path-cross.stripRootPrefix(X6:含路径边界
  // 保护 + 平台感知大小写)。跨平台审计 P2:此前手写 `e.path.startsWith(rootPath)`
  // 仍是大小写敏感且无边界 → Windows 上 rootPath 与 FileEntry.path 仅大小写不同 / canonical
  // 形式时 relPath 退化为绝对路径 → Quick Open 路径显示 + 相对片段搜索失真。
  const capacity = Math.min(maxFiles, entries.length); // 非正 / NaN 的 maxFiles 已在上方早返
  const files = new Array<QuickOpenFile>(capacity);
  let fileCount = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    // 显示与匹配用 NFC(VSCode macOS 上 pfs.readdir 即 normalizeNFC):磁盘上 NFD 的名字(如从 HFS+ / 部分工具来的
    // `회의록.md`)与输入法键入的 NFC 查询码元不同,不归一则一个字也搜不到。打开仍用磁盘原样的 absPath。
    const relPath = stripRootPrefix(rootPath, e.path).normalize('NFC');
    files[fileCount] = {
      absPath: e.path,
      relPath,
      relPathLower: relPath.toLowerCase(), // perf P16:scan 时预算一次
      name: e.name.normalize('NFC'),
    };
    fileCount += 1;
    if (fileCount >= maxFiles) break;
  }
  files.length = fileCount;
  return {
    ok: true,
    data: fileCount === 0 ? EMPTY_QUICK_OPEN_FILES : files,
    ...(skippedDirs > 0 && { skippedDirs }),
  };
}
