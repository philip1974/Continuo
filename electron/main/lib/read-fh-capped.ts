import { constants as fsConstants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

// 边界(E158/E159/E160 stat-before-read TOCTOU 族单一来源):此前各处「先 fs.stat(path) 判 size、
// 再 fs.readFile(path) 整文件」是两次独立按路径解析 —— 检查与读取之间文件可被替换(路径指向新
// inode)或原地增长,绕过大小上限,主进程仍整文件读入。本 helper 用**单个 fd** open→fstat(同
// inode)→有界读,消除该窗口,且读取量恒有界(不依赖 stat,绝不整超大文件读入)。
//
// 错误策略:open 的错误(ENOENT/EACCES 等)**透传抛出**,由调用方按各自契约处理(ENOENT 通常=
// 「缺文件=首次/空表」;非 ENOENT=「当前态未知,绝不降级覆盖」)。size 超限或有界读探测到越限 →
// 返回 { tooLarge:true, text:null },由调用方决定抛错/跳过/当 corrupt。非普通文件(FIFO/socket/设备/目录)→
// 抛 code=EFTYPE(open 带 O_NONBLOCK,FIFO 不会挂住 open)。

export interface CappedFdRead {
  /** 文件内容(≤maxBytes);tooLarge 时为 null。 */
  readonly text: string | null;
  /** 超过 maxBytes(单 fd fstat 或有界读探测到)。 */
  readonly tooLarge: boolean;
  /** 实际读取/探测到的字节数(tooLarge 诊断用)。 */
  readonly size: number;
  /** requireUtf8 时内容含非法 UTF-8 字节(text 为 null)。 */
  readonly notUtf8?: boolean;
  /**
   * noFollow 时:实际读取的 inode 身份(经 fd fstat),供调用方在写入前比对文件未被替换。用 bigint:NTFS 文件 ID
   * 是 64 位、常超过 2^53,Number 会丢精度让不同文件比对相等;比对端须同样 `{ bigint: true }` stat。
   */
  readonly identity?: { readonly dev: bigint; readonly ino: bigint };
}

export interface CappedFdReadOptions {
  /**
   * 严格 UTF-8:非法字节不替换成 U+FFFD,而是返回 `{ notUtf8:true, text:null }`。供编辑器文本读取入口
   * 使用(宽松解码后保存会把非法字节写成 EF BF BD 损坏原文件)。BOM 照旧原样保留(ignoreBOM)。
   */
  readonly requireUtf8?: boolean;
  /**
   * 不跟随末级符号链接、只读普通文件(供读取不可信工作区内配置的入口)。POSIX 用
   * `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`(链接 → ELOOP;O_NONBLOCK 防 FIFO 让 open 挂死),再 fstat 确认普通文件;
   * `fs.constants.O_NOFOLLOW` 不可用(Windows)时退化为 lstat → open → fstat 比对 dev/ino(检查与 open 之间被换
   * 即拒绝)。末级是链接 → 抛 code=ELOOP;非普通文件 → 抛 code=EFTYPE;硬链接(nlink > 1)→ 抛 code=EMLINK
   * (lstat 显示普通文件、O_NOFOLLOW 也挡不住,但可能就是仓库外的全局配置)。只管末级分量,目录分量由调用方负责。
   */
  readonly noFollow?: boolean;
  /** 'base64':text 为原始字节的 base64(二进制读取,如图片预览);与 requireUtf8 互斥(缺省 utf-8 文本)。 */
  readonly encoding?: 'base64';
}

function unsafeFileError(code: 'ELOOP' | 'EFTYPE' | 'EMLINK', filePath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refusing non-regular, symlinked or hard-linked file: ${filePath}`), {
    code,
  });
}

async function openNoFollow(filePath: string): Promise<FileHandle> {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fsConstants;
  if (O_NOFOLLOW !== undefined) {
    return fs.open(filePath, O_RDONLY | O_NOFOLLOW | (O_NONBLOCK ?? 0));
  }
  const pre = await fs.lstat(filePath, { bigint: true });
  if (pre.isSymbolicLink()) throw unsafeFileError('ELOOP', filePath);
  if (!pre.isFile()) throw unsafeFileError('EFTYPE', filePath);
  const fh = await fs.open(filePath, 'r');
  const post = await fh.stat({ bigint: true }).catch(async (err: unknown) => {
    await fh.close().catch(() => {});
    throw err;
  });
  if (post.dev !== pre.dev || post.ino !== pre.ino) {
    await fh.close().catch(() => {});
    throw unsafeFileError('ELOOP', filePath);
  }
  return fh;
}

/**
 * 跟随链接的只读 open(主进程读可能受外部控制的路径一律用它,勿裸 `fs.open(p,'r')`)。安全:必须带 O_NONBLOCK —— 阻塞 open FIFO 在无写端时永不返回,永久占住一个 libuv
 * 线程池线程;工作区可放 FIFO(或指向 FIFO 的链接),并发打开 4 次即占满线程池,主进程所有 fs.promises
 * (保存 / listDir / 持久化)挂死。普通文件读取忽略 O_NONBLOCK,行为不变;非普通文件由调用方 fstat 拒绝。
 * Windows 无 O_NONBLOCK(取 0):其命名管道只在 `\\.\pipe\` 命名空间,无服务端时 open 立即失败,不会挂起。
 */
export function openForReadNonBlocking(filePath: string): Promise<FileHandle> {
  return fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
}

/**
 * TOCTOU 安全的 capped 读:单 fd open → fstat → 至多读 min(size,maxBytes)+1 字节(同一 inode,
 * +1 探测 fstat 后原地增长越限)。open 错误透传;越限返回 tooLarge。
 */
export async function readFileCappedFd(
  filePath: string,
  maxBytes: number,
  opts: CappedFdReadOptions = {},
): Promise<CappedFdRead> {
  // open 错误(ENOENT/EACCES 等)透传给调用方;socket 等特殊文件 open 本身就失败(macOS EOPNOTSUPP,libuv 未映射成
  // 「Unknown system error -102」;Linux ENXIO)→ 与 FIFO(open 成功、fstat 判出)一样归为 EFTYPE(「不是文件」)。
  return withCappedFd(filePath, opts, (fh) => readCappedFromHandle(fh, filePath, maxBytes, opts));
}

/** 同 readFileCappedFd,但返回原始字节(编辑器按编码解码,见 text-codec)。 */
export function readBytesCappedFd(
  filePath: string,
  maxBytes: number,
  opts: Pick<CappedFdReadOptions, 'noFollow'> = {},
): Promise<CappedFdBytes> {
  return withCappedFd(filePath, opts, (fh) => readBytesCappedFromHandle(fh, filePath, maxBytes, opts));
}

async function withCappedFd<T>(
  filePath: string,
  opts: Pick<CappedFdReadOptions, 'noFollow'>,
  read: (fh: FileHandle) => Promise<T>,
): Promise<T> {
  let fh: FileHandle;
  try {
    fh = opts.noFollow ? await openNoFollow(filePath) : await openForReadNonBlocking(filePath);
  } catch (err) {
    throw await specialFileOpenError(err, filePath, opts.noFollow === true);
  }
  try {
    return await read(fh);
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 常见 open 失败原因原样透传;其余(EOPNOTSUPP / ENXIO / 未映射 errno 等)再 stat 一次:是特殊文件 → EFTYPE。 */
const PASS_THROUGH_OPEN_ERRORS: ReadonlySet<string> = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG', 'ENOTDIR', 'EISDIR', 'EMFILE', 'ENFILE', 'EFTYPE', 'EMLINK',
]);

async function specialFileOpenError(err: unknown, filePath: string, noFollow: boolean): Promise<unknown> {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && PASS_THROUGH_OPEN_ERRORS.has(code)) return err;
  const st = await (noFollow ? fs.lstat(filePath) : fs.stat(filePath)).catch(() => null);
  if (st !== null && (st.isSocket() || st.isFIFO() || st.isCharacterDevice() || st.isBlockDevice())) {
    return unsafeFileError('EFTYPE', filePath);
  }
  return err;
}

/** readFileCappedFd 的读取部分:经调用方已打开的 fd(fstat → 有界读);不关闭 fd。filePath 只用于错误信息。 */
export async function readCappedFromHandle(
  fh: FileHandle,
  filePath: string,
  maxBytes: number,
  opts: CappedFdReadOptions = {},
): Promise<CappedFdRead> {
  const { bytes, tooLarge, size, identity } = await readBytesCappedFromHandle(fh, filePath, maxBytes, opts);
  if (bytes === null) return { text: null, tooLarge, size };
  if (opts.requireUtf8) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return { text, tooLarge: false, size, ...(identity && { identity }) };
    } catch {
      return { text: null, tooLarge: false, size, notUtf8: true };
    }
  }
  const encoding = opts.encoding ?? 'utf-8';
  return { text: bytes.toString(encoding), tooLarge: false, size, ...(identity && { identity }) };
}

export interface CappedFdBytes {
  /** 文件字节(≤maxBytes);tooLarge 时为 null。 */
  readonly bytes: Buffer | null;
  readonly tooLarge: boolean;
  readonly size: number;
  /** 同 CappedFdRead.identity(noFollow 时)。 */
  readonly identity?: { readonly dev: bigint; readonly ino: bigint };
}

/** readCappedFromHandle 的字节部分:fstat → 有界读,不解码;不关闭 fd。 */
export async function readBytesCappedFromHandle(
  fh: FileHandle,
  filePath: string,
  maxBytes: number,
  opts: Pick<CappedFdReadOptions, 'noFollow'> = {},
): Promise<CappedFdBytes> {
  const st = await fh.stat({ bigint: true });
  // 只读普通文件(两分支都要):FIFO / socket / 设备 / 目录一律 EFTYPE,不进读循环。
  if (!st.isFile()) throw unsafeFileError('EFTYPE', filePath);
  if (opts.noFollow && st.nlink > 1n) throw unsafeFileError('EMLINK', filePath);
  const identity = opts.noFollow ? { dev: st.dev, ino: st.ino } : undefined;
  const size = Number(st.size);
  if (size > maxBytes) {
    return { bytes: null, tooLarge: true, size };
  }
  const buf = Buffer.allocUnsafe(Math.min(size, maxBytes) + 1);
  let total = 0;
  while (total < buf.length) {
    const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
    if (bytesRead === 0) break; // EOF
    total += bytesRead;
  }
  if (total > maxBytes) {
    return { bytes: null, tooLarge: true, size: total };
  }
  return { bytes: buf.subarray(0, total), tooLarge: false, size: total, ...(identity && { identity }) };
}

/**
 * 读文本且必须在上限内:超限抛无 code 的普通 Error(调用方按「非 ENOENT → 当前态未知,不当空表」处理);
 * open 的 ENOENT / EACCES 等原样透传。explorer.json 与插件元数据(_enabled / _permissions / path-scopes)共用。
 */
export async function readTextCappedOrThrow(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const { text, tooLarge, size } = await readFileCappedFd(filePath, maxBytes);
  if (tooLarge) throw new Error(`${label} too large (${size} > ${maxBytes}): ${filePath}`);
  return text as string; // tooLarge=false 时 text 必为 string
}
