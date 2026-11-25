// 编辑器只读图片预览 / Markdown 图片的受控读取(fs:read-image)。BDD: src/__tests__/editor-image-preview/
// 对齐 VSCode:图片编辑器只读显示;markdown 预览只能加载 localResourceRoots(工作区)内的文件。
// 不放开 file: 协议 —— 图片字节由主进程有界读出,以 data URL 交给 renderer(CSP 既有 `img-src data:`)。
import { realpath } from 'node:fs/promises';
import { ERROR_CODES } from '../../../shared/error-codes';
import type { FsReadImageData } from '../../../shared/fs-channels';
import { imageMimeOf, MAX_IMAGE_PREVIEW_BYTES } from '../../../shared/image-preview';
import { readFileCappedFd, type CappedFdRead } from '../../lib/read-fh-capped';
import { isSameOrInsidePath } from '../../lib/path-inside';
import { fsError, mapNodeErrnoCode } from './path-utils';

/**
 * 读可预览图片为 data URL。
 * - 扩展名不是可预览图片(见 shared/image-preview)→ FS_DENIED,不读。
 * - workspaceRoot 传入(含 null)= 只允许工作区内:先字面判定(不对工作区外路径做任何 IO,含 Windows UNC 主机),
 *   再 realpath 两侧复判(工作区内的符号链接指向外部 → 拒绝),读取 realpath 结果。null(无工作区)→ FS_DENIED。
 * - 单 fd 有界读,超过 MAX_IMAGE_PREVIEW_BYTES → FS_FILE_TOO_LARGE。
 */
export async function readImage(filePath: string, workspaceRoot?: string | null): Promise<FsReadImageData> {
  const mime = imageMimeOf(filePath);
  if (mime === null) throw fsError(ERROR_CODES.FS_DENIED, `not a previewable image: ${filePath}`);
  let target = filePath;
  if (workspaceRoot !== undefined) {
    if (workspaceRoot === null || !isSameOrInsidePath(workspaceRoot, filePath)) {
      throw fsError(ERROR_CODES.FS_DENIED, `image outside workspace: ${filePath}`);
    }
    let realRoot: string;
    try {
      [target, realRoot] = await Promise.all([realpath(filePath), realpath(workspaceRoot)]);
    } catch (err) {
      throw fsError(mapNodeErrnoCode(err), `readImage failed: ${filePath}`);
    }
    if (!isSameOrInsidePath(realRoot, target)) {
      throw fsError(ERROR_CODES.FS_DENIED, `image outside workspace: ${filePath}`);
    }
  }
  let read: CappedFdRead;
  try {
    read = await readFileCappedFd(target, MAX_IMAGE_PREVIEW_BYTES, { encoding: 'base64' });
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `readImage failed: ${filePath}`);
  }
  if (read.tooLarge) {
    throw fsError(
      ERROR_CODES.FS_FILE_TOO_LARGE,
      `image too large (${read.size} > ${MAX_IMAGE_PREVIEW_BYTES}): ${filePath}`,
    );
  }
  return { dataUrl: `data:${mime};base64,${read.text as string}`, size: read.size };
}
