// Quick Open 文件扫描(纯函数)。
//
// 调注入的 listDir 拉 workspace 全量文件,过滤目录,slice 上限,转 relPath。
// 不缓存(每次 ⌘P 重 walk 是策略 b — 简单,大 workspace 第一次稍慢但够用)。
//
// BDD: src/__tests__/quick-open/walk-files.spec.ts

import type { FileEntry } from '../../../electron/shared/fs-entry';
import type { IpcResult } from '../../../electron/shared/ipc-result';
import type { QuickOpenFile } from './store';
import { stripRootPrefix } from '@/lib/path-cross';

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_DEPTH = 8;

// listDir 内置已排:.git / .svn / .hg / node_modules / .DS_Store / Thumbs.db
// 这里追加:常见构建产物 + 缓存目录(VSCode default file.exclude 同思路)。
// 注意 listDir 的 exclude 是完整替换(传了就不用默认),所以这里要给完整列表。
const FULL_EXCLUDE: readonly string[] = [
  // 内置(listDir DEFAULT_EXCLUDE 同款)
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  // 追加:构建产物 + 缓存
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.vite',
];

export type ListDirFn = (
  path: string,
  options?: {
    maxDepth?: number;
    exclude?: readonly string[];
    maxFiles?: number;
  },
) => Promise<IpcResult<readonly FileEntry[]>>;

export interface WalkOptions {
  /** workspace 根. 空 → fail WORKSPACE_NOT_OPEN. */
  readonly rootPath: string;
  readonly listDir: ListDirFn;
  /** 默认 5000. */
  readonly maxFiles?: number;
  /** 追加到 FULL_EXCLUDE 后面的额外 ignore basename. */
  readonly extraExclude?: readonly string[];
}

export type WalkResult = IpcResult<readonly QuickOpenFile[]>;

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
  if (maxFiles <= 0) return { ok: true, data: [] };
  const exclude = opts.extraExclude
    ? [...FULL_EXCLUDE, ...opts.extraExclude]
    : FULL_EXCLUDE;

  // perf P2:把 maxFiles 下推到 main 侧 walker,使其收集够 maxFiles 个文件即停止
  // 遍历(不再扫完整棵树 + lstat + IPC 全量)。下面的 renderer 端 break 仍保留为
  // 防御性二次上限(main 已截断,通常不触发)。
  const r = await listDir(rootPath, {
    maxDepth: DEFAULT_MAX_DEPTH,
    exclude,
    maxFiles,
  });
  if (!r.ok) return r;

  // 分隔符无关地剥 rootPath 前缀 → 复用单一来源 path-cross.stripRootPrefix(X6:含路径边界
  // 保护 + 平台感知大小写)。跨平台审计 P2(codex):此前手写 `e.path.startsWith(rootPath)`
  // 仍是大小写敏感且无边界 → Windows 上 rootPath 与 FileEntry.path 仅大小写不同 / canonical
  // 形式时 relPath 退化为绝对路径 → Quick Open 路径显示 + 相对片段搜索失真。
  const capacity =
    maxFiles > 0 ? Math.min(maxFiles, r.data.length) : 0;
  const files = new Array<QuickOpenFile>(capacity);
  let fileCount = 0;
  for (const e of r.data) {
    if (e.isDirectory) continue;
    const relPath = stripRootPrefix(rootPath, e.path);
    files[fileCount] = {
      absPath: e.path,
      relPath,
      relPathLower: relPath.toLowerCase(), // perf P16:scan 时预算一次
      name: e.name,
    };
    fileCount += 1;
    if (fileCount >= maxFiles) break;
  }
  files.length = fileCount;
  return { ok: true, data: files };
}
