import { ERROR_CODES } from '../../../shared/error-codes';
import type { FileHandle } from 'node:fs/promises';
import { readCappedFromHandle, readFileCappedFd, type CappedFdRead } from '../../lib/read-fh-capped';
import { fsError, lstatOrThrow, mapNodeErrnoCode } from './path-utils';

// 边界(E18,E13 读侧对偶):readFile 整文件读入内存(fspReadFile utf-8)+ 经 IPC 发送。无上限时
// 打开超大文件或恢复多个超大 tab 会一次性分配巨大字符串 → 主进程/IPC 卡死或崩溃。读前用
// stat.size 做明确上限,超限抛 FS_FILE_TOO_LARGE。上限取 64 MiB,与 fs.write 的 MAX_WRITE_BYTES
// (E13)一致 —— 可打开的文件都可保存,无「能开不能存」的数据丢失缺口;编辑器本就无法流畅处理
// 这么大的文本。
const MAX_READ_BYTES = 64 * 1024 * 1024;

export interface ReadFileOptions {
  /**
   * 数据安全(独立审计):非法 UTF-8(GBK / Latin-1 / 二进制)抛 FS_NOT_UTF8,而非宽松解码成 U+FFFD ——
   * 编辑器打开后保存会把非法字节写回 EF BF BD,不可逆损坏原文件(参考 VSCode 不在文本编辑器中打开
   * 二进制 / 不支持编码的文件)。编辑器入口 readFile 恒开启;插件 fs(readFileFromHandle)默认宽松,契约不变。
   */
  readonly requireUtf8?: boolean;
}

/** 编辑器入口(fs:read-file)的整文件读取:恒要求合法 UTF-8(见 ReadFileOptions.requireUtf8)。 */
export async function readFile(filePath: string): Promise<string> {
  const st = await lstatOrThrow(filePath);
  if (st.isDirectory()) {
    throw fsError(ERROR_CODES.FS_NOT_FILE, `not a file: ${filePath}`);
  }
  // 边界(E163,stat-before-read 族 symlink 变体):此前用 `lstat(filePath).size` 做 64MiB 上限检查,
  // 但 lstat 不跟随 symlink —— 一个很小的 symlink 可指向超大目标,而随后的 readFile **跟随 symlink**
  // 读目标内容 → 绕过 cap,主进程整块读入 + IPC 发送 OOM/卡死。改用共享 readFileCappedFd(open 跟随
  // symlink → fstat 报目标真实大小 → 有界读 maxBytes+1),size 上限对读取的真实目标权威生效且读取量
  // 恒有界。isDirectory 检查仍用上面 lstat(no-follow)保留 FS_NOT_FILE 语义。
  let read: CappedFdRead;
  try {
    read = await readFileCappedFd(filePath, MAX_READ_BYTES, { requireUtf8: true });
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `readFile failed: ${filePath}`);
  }
  return unwrapCappedRead(read, filePath);
}

/**
 * 同 readFile(同一上限与错误码),但经调用方已打开并校验过的 fd 读(plugin-fs:打开后复核身份再读,见
 * readFileVerified);不关闭 fd。非普通文件(含目录)→ FS_NOT_FILE。
 */
export async function readFileFromHandle(
  fh: FileHandle,
  filePath: string,
  opts: ReadFileOptions = {},
): Promise<string> {
  let read: CappedFdRead;
  try {
    read = await readCappedFromHandle(fh, filePath, MAX_READ_BYTES, { requireUtf8: opts.requireUtf8 === true });
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `readFile failed: ${filePath}`);
  }
  return unwrapCappedRead(read, filePath);
}

function unwrapCappedRead(read: CappedFdRead, filePath: string): string {
  if (read.tooLarge) {
    throw fsError(
      ERROR_CODES.FS_FILE_TOO_LARGE,
      `file too large (${read.size} > ${MAX_READ_BYTES}): ${filePath}`,
    );
  }
  if (read.notUtf8) {
    throw fsError(ERROR_CODES.FS_NOT_UTF8, `file is not valid UTF-8: ${filePath}`);
  }
  return read.text as string; // tooLarge=false 时必为 string
}
