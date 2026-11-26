import { mkdir, open, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ERROR_CODES } from '../../../shared/error-codes';
import type { FsCreated } from '../../../shared/fs-channels';
import { splitRelativeName } from '../../../shared/leaf-name';
import { fsError, mapNodeErrnoCode } from './path-utils';

/**
 * 新建名可以是相对路径(VSCode 同款 `a/b/c.ts`):拆段并逐段按 leaf 规则校验(空段 / `.` / `..` / 绝对路径 / 盘符
 * 一律拒,结果必在 dirPath 内;见 splitRelativeName)。不合法 → FS_BAD_NAME(错误串只含长度摘要,同 assertValidBasename)。
 */
function segmentsOrThrow(name: string): string[] {
  const segments = splitRelativeName(name);
  if (segments === null) {
    throw fsError(
      ERROR_CODES.FS_BAD_NAME,
      `invalid name (len ${typeof name === 'string' ? name.length : 'n/a'})`,
    );
  }
  return segments;
}

/** 回滚本次建出的中间目录(最深的先删;rmdir 只删空目录,期间被别人放进东西的保留)。 */
async function rollback(createdDirs: readonly string[]): Promise<void> {
  for (const dir of [...createdDirs].reverse()) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
  }
}

/**
 * 逐级确保 base 下的中间目录存在(mkdir -p,但逐段非递归 mkdir 以记下哪些是本次建的):已存在且是目录 → 沿用;
 * 已存在但不是目录 → FS_NOT_DIRECTORY;其它失败映射 errno。失败时回滚本次已建的目录。
 */
async function ensureDirs(base: string, segments: readonly string[], createdDirs: string[]): Promise<string> {
  let cur = base;
  for (const seg of segments) {
    cur = path.join(cur, seg);
    try {
      await mkdir(cur); // non-recursive:EEXIST 区分「已存在」与「本次建的」
      createdDirs.push(cur);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'EEXIST') {
        const st = await stat(cur).catch(() => null);
        if (st?.isDirectory()) continue;
        await rollback(createdDirs);
        throw fsError(ERROR_CODES.FS_NOT_DIRECTORY, `not a directory: ${cur}`);
      }
      await rollback(createdDirs);
      throw fsError(mapNodeErrnoCode(err), `mkdir failed: ${cur}`);
    }
  }
  return cur;
}

/**
 * 创建空文件(name 可带中间目录,逐级创建)。已存在 → FS_EEXIST(防覆盖既有文件),本次建出的中间目录回滚。
 * 返回 path = 新文件,created = 本次新建的最上层项(没有新建中间目录时 = path;撤销新建删它即覆盖整条链,已存在的目录不动)。
 *
 * 用 `open(newPath, 'wx')` 原子排他创建:flag `wx` = O_CREAT|O_EXCL,内核保证「不存在
 * 才创建,已存在即 EEXIST」,无 TOCTOU。此前用 `stat` 判不存在再 `atomicWriteFile`(其
 * rename 无条件覆盖)有竞态窗口:stat 后、rename 前并发创建的文件会被空文件覆盖 → 丢内容
 * (数据安全复查 P1)。与紧邻 createDir 的 mkdir 排他语义一致。
 */
export async function createFile(dirPath: string, name: string): Promise<FsCreated> {
  const segments = segmentsOrThrow(name);
  const createdDirs: string[] = [];
  const parent = await ensureDirs(dirPath, segments.slice(0, -1), createdDirs);
  const newPath = path.join(parent, segments.at(-1)!);

  try {
    const handle = await open(newPath, 'wx');
    await handle.close();
  } catch (err) {
    await rollback(createdDirs);
    const code = (err as { code?: string }).code;
    if (code === 'EEXIST') {
      throw fsError(ERROR_CODES.FS_EEXIST, `already exists: ${newPath}`);
    }
    throw fsError(mapNodeErrnoCode(err), `create failed: ${newPath}`);
  }
  return { path: newPath, created: createdDirs[0] ?? newPath };
}

/**
 * 创建目录(name 可带中间目录,`a/b` 逐级创建;最后一段排他 mkdir)。已存在 → FS_EEXIST,本次建出的中间目录回滚。
 * 返回值同 createFile。
 */
export async function createDir(parentPath: string, name: string): Promise<FsCreated> {
  const segments = segmentsOrThrow(name);
  const createdDirs: string[] = [];
  const parent = await ensureDirs(parentPath, segments.slice(0, -1), createdDirs);
  const newPath = path.join(parent, segments.at(-1)!);

  try {
    await mkdir(newPath); // non-recursive
  } catch (err) {
    await rollback(createdDirs);
    const code = (err as { code?: string }).code;
    if (code === 'EEXIST') {
      throw fsError(ERROR_CODES.FS_EEXIST, `already exists: ${newPath}`);
    }
    throw fsError(mapNodeErrnoCode(err), `mkdir failed: ${newPath}`);
  }
  return { path: newPath, created: createdDirs[0] ?? newPath };
}
