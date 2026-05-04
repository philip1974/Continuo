import { lstat, rename } from 'node:fs/promises';
import path from 'node:path';
import { assertValidBasename, fsError, mapNodeErrnoCode } from './path-utils';

/**
 * 同目录改 basename。返回新的绝对路径。
 *
 * - newName 必须是单段 basename(无 / \ . ..),否则 FS_BAD_NAME
 * - 源不存在 → FS_NOT_FOUND
 * - 跨目录 / 跨盘移动留给未来 fs:move,本函数只做改名
 */
export async function renameEntry(
  oldPath: string,
  newName: string,
): Promise<string> {
  assertValidBasename(newName);

  // 先校验源存在(避免 rename 抛出难以解读的 errno)
  try {
    await lstat(oldPath);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `lstat failed: ${oldPath}`);
  }

  const newPath = path.join(path.dirname(oldPath), newName);
  try {
    await rename(oldPath, newPath);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `rename failed: ${oldPath} → ${newName}`);
  }
  return newPath;
}
