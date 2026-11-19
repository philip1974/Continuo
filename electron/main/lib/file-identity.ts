// 文件系统身份判定的共用件:「文件系统认为相同、路径字符串认为不同」的地方(macOS `/.nofollow/<绝对路径>`、
// 数据卷 firmlink `/System/Volumes/Data/<绝对路径>`,Linux bind mount,Windows subst 盘符 —— realpath 都不归一)
// 一律按 (dev, ino) 比,不比路径字符串。使用方:path-scope-registry(受保护根)、mcp-tools-hook-bridge
// (stop hook 安装位置)、scope-request-throttle(拒绝冷却键)。
import { dirname } from 'node:path';

/** 文件身份 = (dev, ino)。 */
export type FileId = string;

/** ino 为 0(个别文件系统不提供)时不可比较 → null。 */
export function fileIdOf(stat: { readonly dev: bigint; readonly ino: bigint } | null): FileId | null {
  return stat === null || stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`;
}

/** 路径自身及其各级上级(字符串 dirname,直到文件系统根),由深到浅。 */
export function prefixesOf(p: string): string[] {
  const out = [p];
  for (;;) {
    const current = out[out.length - 1]!;
    const parent = dirname(current);
    if (parent === current) return out;
    out.push(parent);
  }
}

/**
 * 「尚不存在的名字」专用的保守折叠:比文件系统折得更狠(兼容分解、大小写往返 —— `ſ`→`s`、`ß`→`ss`、连字、
 * final sigma;去掉默认可忽略码位)。只用来判断「新建的名字会不会与受保护根应在位置上的名字撞」,多拒无害;
 * 不求与任何一种文件系统的折叠表逐字一致(见 plugin-fs-protected-roots README 残余)。
 */
export function conservativeFold(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize('NFKC');
}

// macOS 根目录下由内核合成的路径前缀:`/.nofollow/<绝对路径>` 与 `<绝对路径>` 是同一个文件(只是沿途不跟随
// 符号链接),`/.resolve/<n>/<绝对路径>`、`/.vol/<dev>/<ino>` 同理 —— 而 realpath 不归一(或直接失败)。
// 它们不是访问用户文件的正当写法,一律不认。
const DARWIN_MAGIC_ROOT_ENTRIES: ReadonlySet<string> = new Set(['.nofollow', '.resolve', '.vol']);

export function isDarwinMagicPath(p: string): boolean {
  if (process.platform !== 'darwin') return false;
  const first = p.split('/').find((segment) => segment !== '');
  return first !== undefined && DARWIN_MAGIC_ROOT_ENTRIES.has(conservativeFold(first));
}
