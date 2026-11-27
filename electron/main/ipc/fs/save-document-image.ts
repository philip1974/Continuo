// fs:save-document-image:Markdown 文档里粘贴 / 拖入的图片落盘(对齐 VSCode markdown copyFiles 的默认目的地:文档所在目录)。
// 安全边界(renderer 只给文档路径、想要的文件名与字节):
// - 文档必须是发送窗口打开过的 Markdown 文档,且在该窗口的工作区内;目的地 = 文档所在目录,realpath 后仍须在工作区内(目录链接指向
//   工作区外 → 拒绝);
// - 文件名由这里生成(只取末段、去掉不安全字符、扩展名按文件头识别出的格式),不可能穿越目录;
// - 只收图片(按文件头识别,不信扩展名 / MIME),大小有上限;
// - 不覆盖已有文件:`wx` 排他创建(已存在 / 是链接 → 换下一个序号 `image-1.png` …)。
// BDD: src/__tests__/markdown-image-paste/
import { open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ERROR_CODES } from '../../../shared/error-codes';
import {
  documentImageFileName,
  MAX_DOCUMENT_IMAGE_BYTES,
  numberedDocumentImageName,
  sniffDocumentImageMime,
} from '../../../shared/document-image';
import { isSameOrInsidePath } from '../../lib/path-inside';
import { fsError, mapNodeErrnoCode } from './path-utils';

/** 递增序号的尝试上限(同名图片超过这么多张 → FS_EEXIST)。 */
export const DOCUMENT_IMAGE_NAME_ATTEMPTS = 1000;

export interface SaveDocumentImageInput {
  readonly documentPath: string;
  readonly fileName: string;
  readonly data: Uint8Array;
}

export interface SaveDocumentImageContext {
  /** 发送窗口的工作区根(没有 → null)。 */
  readonly workspaceRoot: string | null;
  /** documentPath 是发送窗口打开过的 Markdown 文档。 */
  readonly isWindowDocument: (documentPath: string) => boolean;
}

/** 写入图片,返回新文件路径(= 文档所在目录 + 新文件名;目录按文档路径的字面形式)。 */
export async function saveDocumentImage(input: SaveDocumentImageInput, ctx: SaveDocumentImageContext): Promise<string> {
  const { documentPath, data } = input;
  const root = ctx.workspaceRoot;
  if (root === null || !path.isAbsolute(documentPath) || !isSameOrInsidePath(root, documentPath)) {
    throw fsError(ERROR_CODES.FS_DENIED, 'document is not inside the workspace');
  }
  if (!ctx.isWindowDocument(documentPath)) throw fsError(ERROR_CODES.FS_DENIED, 'not an open Markdown document');
  if (data.length > MAX_DOCUMENT_IMAGE_BYTES) {
    throw fsError(ERROR_CODES.FS_FILE_TOO_LARGE, `image too large (${data.length} > ${MAX_DOCUMENT_IMAGE_BYTES})`);
  }
  const mime = sniffDocumentImageMime(data);
  if (mime === null) throw fsError(ERROR_CODES.FS_DENIED, 'not a supported image');

  const dir = path.dirname(documentPath);
  let realDir: string;
  let realRoot: string;
  try {
    [realDir, realRoot] = await Promise.all([realpath(dir), realpath(root)]);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), 'image destination unavailable');
  }
  if (!isSameOrInsidePath(realRoot, realDir)) throw fsError(ERROR_CODES.FS_DENIED, 'destination outside the workspace');

  const name = documentImageFileName(input.fileName, mime);
  for (let i = 0; i < DOCUMENT_IMAGE_NAME_ATTEMPTS; i++) {
    const candidate = numberedDocumentImageName(name, i);
    const target = path.join(realDir, candidate);
    let handle;
    try {
      handle = await open(target, 'wx');
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') continue;
      throw fsError(mapNodeErrnoCode(err), 'image write failed');
    }
    try {
      await handle.writeFile(data);
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => {});
      await unlink(target).catch(() => {});
      throw fsError(mapNodeErrnoCode(err), 'image write failed');
    }
    return path.join(dir, candidate);
  }
  throw fsError(ERROR_CODES.FS_EEXIST, 'too many images with the same name');
}
