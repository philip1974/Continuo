// Drop 上传纯逻辑(M-Explorer Step 5d)。
// 把 DataTransferItemList / FileList 解析成可写入的 (path, bytes) 列表,
// 调 fs.writeBinary 写入,聚合成 DropResult 给 UI 提示。
//
// UI 层(FolderTree)只负责 dnd 事件接入与 hover 高亮,业务全在这里。

import type { IpcResult } from '@/lib/fs/types';
import { errorMessage } from '../../../electron/shared/error-message';

export interface DropTargetEntry {
  path: string;
  isDirectory: boolean;
}

export interface DropFsApi {
  writeBinary: (path: string, content: Uint8Array) => Promise<IpcResult<void>>;
}

export interface DropResult {
  ok: boolean;
  written: string[];
  skipped: string[];
  failed: { name: string; code: string; message: string }[];
}

function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return '';
  return trimmed.slice(0, idx) || '/';
}

/**
 * 落点判定:
 *  - target=null   → root(空白拖入)
 *  - target=folder → folder.path(进文件夹)
 *  - target=file   → dirname(file.path)(进文件父目录)
 */
export function resolveDropTarget(
  target: DropTargetEntry | null,
  rootPath: string,
): string {
  if (!target) return rootPath;
  if (target.isDirectory) return target.path;
  return dirname(target.path);
}

export interface PartitionResult {
  files: File[];
  skippedDirs: string[];
}

/**
 * 把 DataTransferItemList 拆成 file / 目录(skip)。
 * 文件夹拖入复杂(需 webkitGetAsEntry 递归),MVP 不支持;
 * 检测到目录就 skip,UI 层显示提示。
 */
export function partitionDropItems(
  items: DataTransferItemList | null,
): PartitionResult {
  const files: File[] = [];
  const skippedDirs: string[] = [];
  if (!items) return { files, skippedDirs };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || item.kind !== 'file') continue;

    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => { isDirectory: boolean; name: string } | null;
    }).webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      skippedDirs.push(entry.name);
      continue;
    }

    const f = item.getAsFile();
    if (f) files.push(f);
  }
  return { files, skippedDirs };
}

/**
 * 顺序写入文件到 targetDir。同名文件由 fs.writeBinary 内部 atomic 覆盖,不弹确认。
 */
export async function performDrop(
  files: ReadonlyArray<File>,
  targetDir: string,
  fs: DropFsApi,
): Promise<DropResult> {
  const written: string[] = [];
  const failed: { name: string; code: string; message: string }[] = [];

  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      failed.push({
        name: file.name,
        code: 'READ_ERROR',
        message: errorMessage(err),
      });
      continue;
    }
    const targetPath = `${targetDir}/${file.name}`;
    const r = await fs.writeBinary(targetPath, bytes);
    if (r.ok) {
      written.push(targetPath);
    } else {
      failed.push({ name: file.name, code: r.code, message: r.message });
    }
  }

  return {
    ok: failed.length === 0,
    written,
    skipped: [],
    failed,
  };
}
