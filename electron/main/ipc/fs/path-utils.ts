import path from 'node:path';
import { ERROR_CODES } from '../../../shared/error-codes';
import type { FsErrorCode } from '../../../shared/error-codes';
import { isValidLeafName } from '../../../shared/leaf-name';

/**
 * 路径规范化:相对 → 绝对,解析 ../ 防遍历。
 *
 * VSCode 风(ADR-006):**不做** home 沙箱、敏感目录黑名单、symlink 解析校验。
 * 信任 OS 文件权限;危险操作的二次确认由 renderer UI 层负责(见 R7)。
 */
export function normalizePath(input: string): string {
  return path.resolve(input);
}

/** 创建带 code 字段的业务异常,safeHandle 会透传 code 到 IpcResult。 */
export function fsError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** 把 node fs 抛的 errno code 映射到我们的业务 code。 */
export function mapNodeErrnoCode(err: unknown): FsErrorCode {
  const e = err as { code?: string };
  switch (e.code) {
    case 'ENOENT':
      return ERROR_CODES.FS_NOT_FOUND;
    case 'ENOTDIR':
      return ERROR_CODES.FS_NOT_DIRECTORY;
    case 'EISDIR':
      return ERROR_CODES.FS_NOT_FILE;
    // ERR_FS_CP_EEXIST:fs.cp(force:false, errorOnExist:true) 目标已存在时的专用码,语义同 EEXIST。
    case 'EEXIST':
    case 'ERR_FS_CP_EEXIST':
      return ERROR_CODES.FS_EEXIST;
    case 'EACCES':
    case 'EPERM':
      return ERROR_CODES.FS_DENIED;
    default:
      return ERROR_CODES.FS_IO;
  }
}

/**
 * basename 合法性校验。renderer 传来的 newName 必须是单段名,
 * 不能含路径分隔符,不能是 . / ..(防越级越权)。
 */
export function assertValidBasename(name: string): void {
  // 边界(E268):委托共享 isValidLeafName(单一来源,消漂移 + 增长度/控制字符上限)。错误串只含长度摘要,
  // 不嵌入完整 name(可能超长/含控制字符 → 错误串放大/污染,同 E254)。
  if (!isValidLeafName(name)) {
    throw fsError(
      ERROR_CODES.FS_BAD_NAME,
      `invalid leaf name (len ${typeof name === 'string' ? name.length : 'n/a'})`,
    );
  }
}
