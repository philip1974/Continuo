// Quick Open 文件扫描(纯函数)。
//
// 调注入的 listDir 拉 workspace 全量文件,过滤目录,slice 上限,转 relPath。
// 不缓存(每次 ⌘P 重 walk 是策略 b — 简单,大 workspace 第一次稍慢但够用)。
//
// BDD: src/__tests__/quick-open/walk-files.spec.ts

import type { FileEntry } from '../../../electron/shared/fs-entry';
import type { IpcResult } from '../../../electron/shared/ipc-result';
import type { QuickOpenFile } from './store';

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
  options?: { maxDepth?: number; exclude?: readonly string[] },
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
  const exclude = opts.extraExclude
    ? [...FULL_EXCLUDE, ...opts.extraExclude]
    : FULL_EXCLUDE;

  const r = await listDir(rootPath, {
    maxDepth: DEFAULT_MAX_DEPTH,
    exclude,
  });
  if (!r.ok) return r;

  // rootPath 末尾可能带 / — 统一截 prefix(留 1 字符给前导 /)
  const prefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;

  const files: QuickOpenFile[] = [];
  for (const e of r.data) {
    if (e.isDirectory) continue;
    files.push({
      absPath: e.path,
      relPath: e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path,
      name: e.name,
    });
    if (files.length >= maxFiles) break;
  }
  return { ok: true, data: files };
}
