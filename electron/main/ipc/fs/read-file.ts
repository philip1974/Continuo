import { ERROR_CODES } from '../../../shared/error-codes';
import type { FileHandle } from 'node:fs/promises';
import { readBytesCappedFd, readCappedFromHandle, type CappedFdBytes, type CappedFdRead } from '../../lib/read-fh-capped';
import { decodeTextFile } from '../../lib/text-codec';
import type { TextEncodingId } from '../../../shared/text-encoding';
import { fsError, lstatOrThrow, mapNodeErrnoCode } from './path-utils';
import { MAX_WRITE_BYTES } from '../../../shared/fs-limits';

// 边界(E18,E13 读侧对偶):readFile 整文件读入内存(fspReadFile utf-8)+ 经 IPC 发送。无上限时
// 打开超大文件或恢复多个超大 tab 会一次性分配巨大字符串 → 主进程/IPC 卡死或崩溃。读前用
// stat.size 做明确上限,超限抛 FS_FILE_TOO_LARGE。上限取 64 MiB,与 fs.write 的 MAX_WRITE_BYTES
// (E13)一致 —— 可打开的文件都可保存,无「能开不能存」的数据丢失缺口;编辑器本就无法流畅处理
// 这么大的文本。
const MAX_READ_BYTES = MAX_WRITE_BYTES;

export interface ReadFileOptions {
  /**
   * 数据安全(独立审计):非法 UTF-8(GBK / Latin-1 / 二进制)抛 FS_NOT_UTF8,而非宽松解码成 U+FFFD ——
   * 编辑器打开后保存会把非法字节写回 EF BF BD,不可逆损坏原文件(参考 VSCode 不在文本编辑器中打开
   * 二进制 / 不支持编码的文件)。编辑器入口 readFile 按编码严格解码(见 readFile);插件 fs(readFileFromHandle)默认宽松,契约不变。
   */
  readonly requireUtf8?: boolean;
}

/** 编辑器入口(fs:read-file)读出的文本:content 不含 BOM,encoding = 实际使用的编码(BOM 由它表示)。 */
export interface EditorTextRead {
  readonly content: string;
  readonly encoding: TextEncodingId;
}

/**
 * 编辑器入口(fs:read-file)的整文件读取,按编码解码(见 text-codec decodeTextFile;BDD: src/__tests__/editor-text-encoding/):
 * - 未指定编码:BOM → UTF-8 BOM / UTF-16 LE / BE;无 BOM 的 UTF-16(0 字节启发式);否则必须是合法 UTF-8。
 *   二进制 → FS_NOT_UTF8(提示不变);像文本但不是 UTF-8 → FS_UNKNOWN_ENCODING(可「通过编码重新打开」)。
 * - 指定编码(用户「通过编码重新打开」):按该编码;不可逆(保存会写坏原文件)→ FS_DECODE_FAILED。
 * 数据安全(独立审计):永不宽松解码成 U+FFFD(否则保存把非法字节写回 EF BF BD,不可逆损坏原文件)。
 */
export async function readFile(filePath: string, encoding?: TextEncodingId): Promise<EditorTextRead> {
  const st = await lstatOrThrow(filePath);
  if (st.isDirectory()) {
    throw fsError(ERROR_CODES.FS_NOT_FILE, `not a file: ${filePath}`);
  }
  // 边界(E163,stat-before-read 族 symlink 变体):此前用 `lstat(filePath).size` 做 64MiB 上限检查,
  // 但 lstat 不跟随 symlink —— 一个很小的 symlink 可指向超大目标,而随后的 readFile **跟随 symlink**
  // 读目标内容 → 绕过 cap,主进程整块读入 + IPC 发送 OOM/卡死。改用共享有界单 fd 读(open 跟随
  // symlink → fstat 报目标真实大小 → 有界读 maxBytes+1),size 上限对读取的真实目标权威生效且读取量
  // 恒有界。isDirectory 检查仍用上面 lstat(no-follow)保留 FS_NOT_FILE 语义。
  let read: CappedFdBytes;
  try {
    read = await readBytesCappedFd(filePath, MAX_READ_BYTES);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `readFile failed: ${filePath}`);
  }
  if (read.bytes === null) throw tooLargeError(read.size, filePath);
  const decoded = decodeTextFile(read.bytes, encoding);
  if (decoded.ok) return { content: decoded.text, encoding: decoded.encoding };
  switch (decoded.reason) {
    case 'binary':
      throw fsError(ERROR_CODES.FS_NOT_UTF8, `file is binary: ${filePath}`);
    case 'unknown-encoding':
      throw fsError(ERROR_CODES.FS_UNKNOWN_ENCODING, `file is not valid UTF-8: ${filePath}`);
    default:
      throw fsError(ERROR_CODES.FS_DECODE_FAILED, `file cannot be decoded losslessly as ${encoding}: ${filePath}`);
  }
}

function tooLargeError(size: number, filePath: string): Error {
  return fsError(ERROR_CODES.FS_FILE_TOO_LARGE, `file too large (${size} > ${MAX_READ_BYTES}): ${filePath}`);
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
  if (read.tooLarge) throw tooLargeError(read.size, filePath);
  if (read.notUtf8) {
    throw fsError(ERROR_CODES.FS_NOT_UTF8, `file is not valid UTF-8: ${filePath}`);
  }
  return read.text as string; // tooLarge=false 时必为 string
}
