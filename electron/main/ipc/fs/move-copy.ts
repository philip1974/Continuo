// fs:move / fs:copy(M-Explorer 剪切/复制/粘贴 IPC,2026-05)。
//
// move:fs.rename(src, dest);跨盘 EXDEV → fallback cp + rm
// copy:fs.cp recursive(Node 16+ 内置,递归 + 保留 mtime)
//
// dest 含目标 basename(parentDir/<name>);调用方负责 parent 存在性 +
// 重名处理(本层不自动改名,EEXIST 直返 FS_EEXIST)。

import { cp, lstat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fsError, mapNodeErrnoCode } from './path-utils';

/**
 * 移动 entry(rename 跨目录;同盘 atomic,跨盘走 cp+rm fallback)。
 *
 * - srcPath 不存在 → FS_NOT_FOUND
 * - destPath 已存在 → FS_EEXIST(调用方决定是否覆盖 / 改名)
 * - 跨盘 EXDEV → 自动 cp recursive + rm,但**非 atomic**(中途断电可能
 *   只完成一半 — 注释提醒,生产单盘场景几乎无问题)
 */
export async function moveEntry(
  srcPath: string,
  destPath: string,
): Promise<void> {
  // 校验源存在
  try {
    await lstat(srcPath);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `lstat failed: ${srcPath}`);
  }
  // 拒绝 dest 已存在(避免静默覆盖)
  let destExists = false;
  try {
    await lstat(destPath);
    destExists = true;
  } catch {
    // 不存在(ENOENT),按预期
  }
  if (destExists) {
    throw fsError('FS_EEXIST', `destination already exists: ${destPath}`);
  }

  try {
    await rename(srcPath, destPath);
    return;
  } catch (err) {
    const e = err as { code?: string };
    if (e.code !== 'EXDEV') {
      throw fsError(mapNodeErrnoCode(err), `rename failed: ${srcPath} → ${destPath}`);
    }
    // 跨盘 fallback:cp -r + rm -rf
  }

  try {
    await cp(srcPath, destPath, { recursive: true, errorOnExist: true });
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `cross-device cp failed: ${srcPath} → ${destPath}`);
  }
  try {
    await rm(srcPath, { recursive: true, force: true });
  } catch (err) {
    // cp 成功但 rm 失败:dest 已就位,src 残留 — 只 warn,不抛(避免数据丢失)
     
    console.warn('[fs:move] cross-device cp succeeded but rm failed', err);
  }
}

/**
 * 递归复制(Node fs.cp,recursive + errorOnExist=true 防覆盖)。
 *
 * - srcPath 不存在 → FS_NOT_FOUND
 * - destPath 已存在 → FS_EEXIST
 */
export async function copyEntry(
  srcPath: string,
  destPath: string,
): Promise<void> {
  try {
    await lstat(srcPath);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `lstat failed: ${srcPath}`);
  }
  try {
    await cp(srcPath, destPath, { recursive: true, errorOnExist: true });
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `cp failed: ${srcPath} → ${destPath}`);
  }
}

/**
 * 帮手:基于 srcPath 的 basename + parentDir 拼 destPath,处理重名:
 * 若 dest 已存在,自动加 ` copy` / ` copy 2` / ... 后缀(VSCode/Finder 同款),
 * 直到找到不存在的路径。给上层粘贴处理重名用。
 *
 * 上限尝试 100 次防极端情况下死循环。
 */
export async function resolveUniqueDest(
  parentDir: string,
  basename: string,
): Promise<string> {
  const dot = basename.lastIndexOf('.');
  // 隐藏文件 .xxx 或无扩展 → 整体当 stem
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  const ext = dot > 0 ? basename.slice(dot) : '';

  for (let i = 0; i < 100; i++) {
    const candidate =
      i === 0
        ? path.join(parentDir, basename)
        : i === 1
          ? path.join(parentDir, `${stem} copy${ext}`)
          : path.join(parentDir, `${stem} copy ${i}${ext}`);
    try {
      await lstat(candidate);
      // 存在,继续找下一个
    } catch {
      return candidate;
    }
  }
  throw fsError('FS_IO', `cannot find unique dest under ${parentDir} (100 tries)`);
}
