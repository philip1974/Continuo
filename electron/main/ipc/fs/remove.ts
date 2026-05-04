import { lstat, rm } from 'node:fs/promises';
import { fsError, mapNodeErrnoCode } from './path-utils';

/**
 * 硬删(递归)。trash 走系统回收站由 IPC 层调 shell.trashItem 单独实现。
 *
 * - 不存在 → FS_NOT_FOUND(force: false 的语义)
 * - 目录递归删
 */
export async function removeEntry(targetPath: string): Promise<void> {
  // 显式 lstat 一次,确保"不存在"产出 FS_NOT_FOUND
  // (fs.rm 配 force: false 也会抛 ENOENT,这里前置以统一错误形态)
  try {
    await lstat(targetPath);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `lstat failed: ${targetPath}`);
  }

  try {
    await rm(targetPath, { recursive: true, force: false });
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `rm failed: ${targetPath}`);
  }
}
