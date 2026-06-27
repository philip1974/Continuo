import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { ERROR_CODES } from '../../../shared/error-codes';
import { assertValidBasename, fsError, mapNodeErrnoCode } from './path-utils';

/**
 * 创建空文件。已存在 → FS_EEXIST(防覆盖既有文件)。
 *
 * 用 `open(newPath, 'wx')` 原子排他创建:flag `wx` = O_CREAT|O_EXCL,内核保证「不存在
 * 才创建,已存在即 EEXIST」,无 TOCTOU。此前用 `stat` 判不存在再 `atomicWriteFile`(其
 * rename 无条件覆盖)有竞态窗口:stat 后、rename 前并发创建的文件会被空文件覆盖 → 丢内容
 * (codex 数据安全复查 P1)。与紧邻 createDir 的 mkdir 排他语义一致。
 */
export async function createFile(
  dirPath: string,
  name: string,
): Promise<string> {
  assertValidBasename(name);
  const newPath = path.join(dirPath, name);

  try {
    const handle = await open(newPath, 'wx');
    await handle.close();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EEXIST') {
      throw fsError(ERROR_CODES.FS_EEXIST, `already exists: ${newPath}`);
    }
    throw fsError(mapNodeErrnoCode(err), `create failed: ${newPath}`);
  }
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
