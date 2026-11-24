import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { ERROR_CODES } from '../../../shared/error-codes';
import type { FsErrorCode } from '../../../shared/error-codes';
import { isValidLeafName } from '../../../shared/leaf-name';
import { codedError } from '../../../shared/error-message';

/** 创建带 code 字段的业务异常(= 共享 codedError;fs 域沿用此名)。 */
export const fsError = codedError;

/** 把 node fs 抛的 errno code 映射到我们的业务 code。 */
export function mapNodeErrnoCode(err: unknown): FsErrorCode {
  const e = err as { code?: string };
  switch (e.code) {
    case 'ENOENT':
      return ERROR_CODES.FS_NOT_FOUND;
    case 'ENOTDIR':
      return ERROR_CODES.FS_NOT_DIRECTORY;
    case 'EISDIR':
    case 'EFTYPE': // readFileCappedFd:FIFO / socket / 设备等非普通文件
      return ERROR_CODES.FS_NOT_FILE;
    // ERR_FS_CP_EEXIST:fs.cp(force:false, errorOnExist:true) 目标已存在时的专用码,语义同 EEXIST。
    case 'EEXIST':
    case 'ERR_FS_CP_EEXIST':
      return ERROR_CODES.FS_EEXIST;
    case 'EACCES':
    case 'EPERM':
      return ERROR_CODES.FS_DENIED;
    default:
      return ERROR_CODES.FS_IO;
  }
}

/**
 * basename 合法性校验。renderer 传来的 newName 必须是单段名,
 * 不能含路径分隔符,不能是 . / ..(防越级越权)。
 */
export function assertValidBasename(name: string): void {
  // 边界(E268):委托共享 isValidLeafName(单一来源,消漂移 + 增长度/控制字符上限)。错误串只含长度摘要,
  // 不嵌入完整 name(可能超长/含控制字符 → 错误串放大/污染,同 E254)。
  if (!isValidLeafName(name)) {
    throw fsError(
      ERROR_CODES.FS_BAD_NAME,
      `invalid leaf name (len ${typeof name === 'string' ? name.length : 'n/a'})`,
    );
  }
}

/**
 * 改名的目标已存在时,是否其实是「改名到自身」(同 dev+inode,且名字只差大小写 / 规范化)—— 大小写不敏感盘上
 * File.txt→file.txt 放行;同 inode 的不同硬链接(a.txt→b.txt)名字不同,POSIX rename 对其 no-op 却返回成功 → 不算,
 * 仍按已存在拒绝。Explorer 改名与插件 fs.rename 共用(此前各写一份)。源 stat 缺失 → 不算(从严拒绝)。
 */
export function isRenameOntoSelf(
  srcSt: { readonly ino: number | bigint; readonly dev: number | bigint } | null,
  dstSt: { readonly ino: number | bigint; readonly dev: number | bigint },
  srcPath: string,
  destPath: string,
): boolean {
  return (
    srcSt !== null &&
    dstSt.ino === srcSt.ino &&
    dstSt.dev === srcSt.dev &&
    isCaseOrNormalizationOnlyRename(srcPath, destPath)
  );
}

/**
 * 两路径 basename 是否只差大小写 / Unicode 规范化(大小写不敏感盘上 File.txt→file.txt、NFD↔NFC)。
 * rename 的「同 inode 即改名到自身」放行须再满足此条件:同 inode 的不同硬链接(a.txt / b.txt)
 * 名字不同,POSIX rename 对其是 no-op 却返回成功 → 必须按目标已存在拒绝。调用方均已保证同父目录,
 * 故只比 basename。
 */
export function isCaseOrNormalizationOnlyRename(srcPath: string, destPath: string): boolean {
  const fold = (p: string): string => path.basename(p).normalize('NFC').toLowerCase();
  return fold(srcPath) === fold(destPath);
}

/**
 * lstat(不跟随符号链接),失败统一映射为带业务 code 的 fsError(不存在 → FS_NOT_FOUND 等)。
 * rename / read-file / move / copy 的「先确认源存在」前置共用。
 */
export async function lstatOrThrow(targetPath: string): Promise<Stats> {
  try {
    return await lstat(targetPath);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `lstat failed: ${targetPath}`);
  }
}
