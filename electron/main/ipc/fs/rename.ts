import { lstat, rename } from 'node:fs/promises';
import path from 'node:path';
import { ERROR_CODES } from '../../../shared/error-codes';
import {
  assertValidBasename,
  fsError,
  isRenameOntoSelf,
  lstatOrThrow,
  mapNodeErrnoCode,
} from './path-utils';

/**
 * 同目录改 basename。返回新的绝对路径。
 *
 * - newName 必须是单段 basename(无 / \ . ..),否则 FS_BAD_NAME
 * - 源不存在 → FS_NOT_FOUND
 * - 目标已存在 → FS_EEXIST(防静默覆盖,与 moveEntry 对齐);唯一例外是同 inode 且名字只差
 *   大小写 / Unicode 规范化(大小写不敏感盘上改名到自身)
 * - 跨目录 / 跨盘移动走 fs:move(move-copy.ts),本函数只做改名
 */
export async function renameEntry(
  oldPath: string,
  newName: string,
): Promise<string> {
  assertValidBasename(newName);

  // 先校验源存在(避免 rename 抛出难以解读的 errno)
  const srcSt = await lstatOrThrow(oldPath);

  const newPath = path.join(path.dirname(oldPath), newName);

  // 拒绝静默覆盖已存在的目标。POSIX rename(2) 会原子覆盖既有文件/空目录 →
  // 不加这层防御,Explorer 把 A 改成已存在的 B 的名字会永久丢失 B。
  // 大小写不敏感盘上 File.txt→file.txt 等"改名到自身"(同 inode)仍放行;但同 inode 的不同
  // 硬链接(a.txt→b.txt)名字不同,POSIX rename 对其是 no-op 却返回成功 → 仍按已存在拒绝。
  try {
    const dstSt = await lstat(newPath);
    if (!isRenameOntoSelf(srcSt, dstSt, oldPath, newPath)) {
      throw fsError(ERROR_CODES.FS_EEXIST, `destination already exists: ${newPath}`);
    }
  } catch (err) {
    if ((err as { code?: string }).code === ERROR_CODES.FS_EEXIST) throw err;
    // 只有 ENOENT(目标不存在)才继续改名。EACCES/EIO/ELOOP 等「无法确认目标状态」的
    // lstat 错误**不能** fail-open —— 否则防覆盖守卫被绕过,POSIX rename 静默覆盖已有目标
    // (P1)。映射后抛出中止 rename。
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw fsError(mapNodeErrnoCode(err), `lstat failed: ${newPath}`);
    }
  }

  try {
    await rename(oldPath, newPath);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `rename failed: ${oldPath} → ${newName}`);
  }
  return newPath;
}
