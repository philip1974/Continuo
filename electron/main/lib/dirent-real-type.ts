import { lstat as fsLstat } from 'node:fs/promises';

export interface DirentTypeLike {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface RealEntryType {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
}

/**
 * dirent 报的类型能否直接采信(不必 lstat)。
 * - 类型未知(三者皆 false,如部分文件系统返回 DT_UNKNOWN)→ 不可采信。
 * - Windows:libuv fs__readdir 对**任何** FILE_ATTRIBUTE_REPARSE_POINT 都报 DT_LINK(先于目录判断),
 *   而 lstat 只把 SYMLINK/LX_SYMLINK/junction/APPEXECLINK 视为链接;OneDrive 按需文件、Dedup 等其它
 *   reparse tag 在 lstat 下是普通文件/目录。故 win32 上 dirent 报 symlink 不可采信。
 *   其它平台 DT_LNK ≡ lstat 链接。
 */
export function direntTypeIsReliable(
  d: DirentTypeLike,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return d.isFile() || d.isDirectory() || (d.isSymbolicLink() && platform !== 'win32');
}

/**
 * dirent 的真实类型:可采信直接用,否则 lstat(不跟随链接 —— 真 symlink / junction 在 lstat 下仍是链接)。
 * lstat 失败 → null,由调用方按各自原有的保守口径处理。
 */
export async function realDirentType(
  d: DirentTypeLike,
  fullPath: string,
  opts: {
    platform?: NodeJS.Platform;
    lstat?: (p: string) => Promise<DirentTypeLike>;
  } = {},
): Promise<RealEntryType | null> {
  let t: DirentTypeLike = d;
  if (!direntTypeIsReliable(d, opts.platform)) {
    try {
      t = await (opts.lstat ?? fsLstat)(fullPath);
    } catch {
      return null;
    }
  }
  return { isFile: t.isFile(), isDirectory: t.isDirectory(), isSymlink: t.isSymbolicLink() };
}
