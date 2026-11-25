// 图片 tab 的「内容」与读取路由。BDD: src/__tests__/editor-image-preview/
// 图片按只读视图打开(对齐 VSCode imagePreview.previewEditor),不经 fs:read-file 文本读取(否则报 FS_NOT_UTF8)。
// tab.content 只存磁盘 stat 指纹:打开 / 会话恢复 / 外部同步 / 还原都走 readEditorFile,指纹变化 → reloadFromDisk
// 递增 reloadEpoch → 视图按 key 重挂重新读图;图片 tab 不可编辑,永不变脏。
import type { FsApi } from '@/lib/fs/api';
import type { FsFileStat, FsReadFileResult } from '../../../electron/shared/fs-channels';
import { isImagePreviewPath } from '../../../electron/shared/image-preview';

export { isImagePreviewPath } from '../../../electron/shared/image-preview';

/** 图片 tab 的内容 = 磁盘身份指纹(外部修改检测用,不是图片数据)。 */
export function imageFingerprint(st: FsFileStat): string {
  return `${st.mtimeMs}:${st.size}:${st.ino}`;
}

/**
 * 编辑器读盘入口:图片 → stat 指纹;其它 → 文本 readFile(要求合法 UTF-8)。非图片原样返回 readFile 的 promise
 *(不多包一层 async:外部同步的在途合并与时序不变)。
 */
export function readEditorFile(
  fs: Pick<FsApi, 'readFile' | 'stat'>,
  path: string,
): Promise<FsReadFileResult> {
  if (!isImagePreviewPath(path)) return fs.readFile(path);
  return fs.stat(path).then((r) => (r.ok ? { ok: true, data: imageFingerprint(r.data) } : r));
}

/** 文件大小(同 VSCode BinarySize.formatSize:B / KB / MB / GB,两位小数)。 */
export function formatBinarySize(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < KB) return `${bytes}B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(2)}KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(2)}MB`;
  return `${(bytes / GB).toFixed(2)}GB`;
}
