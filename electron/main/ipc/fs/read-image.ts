// 编辑器只读图片预览 / Markdown 图片的受控读取(fs:read-image)。BDD: src/__tests__/editor-image-preview/
// 对齐 VSCode:图片编辑器只读显示;markdown 预览只能加载 localResourceRoots(工作区;文档在工作区外时加文档目录)内的文件。
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
 * - allowedRoots 传入 = 只允许在其中某个根内(Markdown 图片:工作区根 + 本窗口打开过的工作区外文档所在目录):
 *   先字面判定(不对根外路径做任何 IO,含 Windows UNC 主机),再 realpath 图片与该根复判(根内的符号链接指向外部 → 拒绝),
 *   读取 realpath 结果。空数组(无工作区且无可用文档目录)→ FS_DENIED。
 * - 单 fd 有界读,超过 MAX_IMAGE_PREVIEW_BYTES → FS_FILE_TOO_LARGE。
 */
export async function readImage(filePath: string, allowedRoots?: readonly string[]): Promise<FsReadImageData> {
  const mime = imageMimeOf(filePath);
  if (mime === null) throw fsError(ERROR_CODES.FS_DENIED, `not a previewable image: ${filePath}`);
  let target = filePath;
  if (allowedRoots !== undefined) {
    const roots = allowedRoots.filter((root) => isSameOrInsidePath(root, filePath));
    if (roots.length === 0) throw fsError(ERROR_CODES.FS_DENIED, `image outside allowed roots: ${filePath}`);
    let realRoots: string[];
    try {
      [target, ...realRoots] = await Promise.all([realpath(filePath), ...roots.map((root) => realpath(root))]);
    } catch (err) {
      throw fsError(mapNodeErrnoCode(err), `readImage failed: ${filePath}`);
    }
    if (!realRoots.some((root) => isSameOrInsidePath(root, target))) {
      throw fsError(ERROR_CODES.FS_DENIED, `image outside allowed roots: ${filePath}`);
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
