import { lstat, rename } from 'node:fs/promises';
import path from 'node:path';
import { ERROR_CODES } from '../../../shared/error-codes';
import { assertValidBasename, fsError, mapNodeErrnoCode } from './path-utils';

/**
 * 同目录改 basename。返回新的绝对路径。
 *
 * - newName 必须是单段 basename(无 / \ . ..),否则 FS_BAD_NAME
 * - 源不存在 → FS_NOT_FOUND
 * - 目标已存在且与源不是同一个 inode → FS_EEXIST(防静默覆盖,与 moveEntry 对齐)
 * - 跨目录 / 跨盘移动留给未来 fs:move,本函数只做改名
 */
export async function renameEntry(
  oldPath: string,
  newName: string,
): Promise<string> {
  assertValidBasename(newName);

  // 先校验源存在(避免 rename 抛出难以解读的 errno)
  let srcSt;
  try {
    srcSt = await lstat(oldPath);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `lstat failed: ${oldPath}`);
  }

  const newPath = path.join(path.dirname(oldPath), newName);

  // 拒绝静默覆盖已存在的目标。POSIX rename(2) 会原子覆盖既有文件/空目录 →
  // 不加这层防御,Explorer 把 A 改成已存在的 B 的名字会永久丢失 B。
  // 仅当目标是与源不同的 inode 时才拒;大小写不敏感盘上 File.txt→file.txt 等
  // "改名到自身"(同 inode)仍放行。
  try {
    const dstSt = await lstat(newPath);
    const sameEntry = dstSt.ino === srcSt.ino && dstSt.dev === srcSt.dev;
    if (!sameEntry) {
      throw fsError(ERROR_CODES.FS_EEXIST, `destination already exists: ${newPath}`);
    }
  } catch (err) {
    if ((err as { code?: string }).code === ERROR_CODES.FS_EEXIST) throw err;
    // ENOENT = 目标不存在,正常继续改名
  }

  try {
    await rename(oldPath, newPath);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `rename failed: ${oldPath} → ${newName}`);
  }
  return newPath;
}
