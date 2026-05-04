import { open, rename, rm, stat } from 'node:fs/promises';
import { fsError, mapNodeErrnoCode } from './path-utils';

/**
 * 原子写文件(ADR-009,借鉴 Lokus atomic_write_file)。
 *
 * 流程:
 *   1. 写 ${path}.tmp
 *   2. fsync(fd)
 *   3. 若 path 已存在,rename path → ${path}.backup
 *   4. rename ${path}.tmp → path     ← POSIX 原子操作
 *   5. 删 ${path}.backup
 *
 * 失败回滚:
 *   - 步骤 1-3 失败:删 .tmp,backup 不动(若已 rename 则手动恢复)
 *   - 步骤 4 之后失败(.backup 删失败等):忽略,数据已落盘
 *
 * 不做:父目录 mkdir(VSCode 行为:save 到不存在的目录就该报错)
 *
 * content 为 string → utf-8 写;为 Uint8Array → 二进制写(Step 5d Dropzone 路径)
 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const backupPath = `${filePath}.backup`;

  // ① 写 tmp + fsync
  let fd;
  try {
    fd = await open(tmpPath, 'w');
    if (typeof content === 'string') {
      await fd.writeFile(content, 'utf-8');
    } else {
      await fd.writeFile(content);
    }
    await fd.sync();
  } catch (err) {
    await fd?.close().catch(() => {});
    await rm(tmpPath, { force: true }).catch(() => {});
    throw fsError(mapNodeErrnoCode(err), `atomic write tmp failed: ${filePath}`);
  } finally {
    await fd?.close().catch(() => {});
  }

  // ② 已存在 → 备份原文件
  let hadOriginal = false;
  try {
    await stat(filePath);
    hadOriginal = true;
  } catch {
    /* 不存在,无需备份 */
  }

  if (hadOriginal) {
    try {
      await rename(filePath, backupPath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw fsError(
        mapNodeErrnoCode(err),
        `atomic write backup failed: ${filePath}`,
      );
    }
  }

  // ③ 原子 rename tmp → path
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    // tmp → path 失败,尝试恢复 backup
    if (hadOriginal) {
      await rename(backupPath, filePath).catch(() => {});
    }
    await rm(tmpPath, { force: true }).catch(() => {});
    throw fsError(
      mapNodeErrnoCode(err),
      `atomic write rename failed: ${filePath}`,
    );
  }

  // ④ cleanup backup(失败也不抛,数据已落盘)
  if (hadOriginal) {
    await rm(backupPath, { force: true }).catch(() => {});
  }
}
