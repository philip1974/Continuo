// 主进程统一的路径包含判定(renderer 侧对应 src/lib/path-cross.isSameOrInsidePath)。
import path from 'node:path';

/**
 * target 是否等于 base 或位于其下(纯字面判定,不解析链接;需要时调用方先 realpath)。
 * Windows 按 path.win32.relative 语义大小写不敏感、跨盘符为假;其它平台 posix 语义、区分大小写。
 */
export function isSameOrInsidePath(
  base: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const rel = p.relative(p.resolve(base), p.resolve(target));
  if (rel === '') return true;
  if (p.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${p.sep}`);
}
