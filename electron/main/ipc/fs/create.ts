import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ERROR_CODES } from '../../../shared/error-codes';
import { atomicWriteFile } from './atomic-write';
import { assertValidBasename, fsError, mapNodeErrnoCode } from './path-utils';

/**
 * 创建空文件。已存在 → FS_EEXIST(防覆盖既有文件)。
 * 走 atomic-write,与编辑器场景同路径,免重复实现。
 */
export async function createFile(
  dirPath: string,
  name: string,
): Promise<string> {
  assertValidBasename(name);
  const newPath = path.join(dirPath, name);

  try {
    await stat(newPath);
    throw fsError(ERROR_CODES.FS_EEXIST, `already exists: ${newPath}`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === ERROR_CODES.FS_EEXIST) throw err;
    if (code !== 'ENOENT') {
      throw fsError(mapNodeErrnoCode(err), `stat failed: ${newPath}`);
    }
    // ENOENT 是预期的"不存在",继续
  }

  await atomicWriteFile(newPath, '');
  return newPath;
}

/**
 * 创建目录。non-recursive(父目录必须存在)。已存在 → FS_EEXIST。
 */
export async function createDir(
  parentPath: string,
  name: string,
): Promise<string> {
  assertValidBasename(name);
  const newPath = path.join(parentPath, name);

  try {
    await mkdir(newPath); // non-recursive
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EEXIST') {
      throw fsError(ERROR_CODES.FS_EEXIST, `already exists: ${newPath}`);
    }
    throw fsError(mapNodeErrnoCode(err), `mkdir failed: ${newPath}`);
  }
  return newPath;
}
