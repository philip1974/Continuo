import path from 'node:path';

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
export function mapNodeErrnoCode(err: unknown): string {
  const e = err as { code?: string };
  switch (e.code) {
    case 'ENOENT':
      return 'FS_NOT_FOUND';
    case 'ENOTDIR':
      return 'FS_NOT_DIRECTORY';
    case 'EISDIR':
      return 'FS_NOT_FILE';
    case 'EEXIST':
      return 'FS_EEXIST';
    case 'EACCES':
    case 'EPERM':
      return 'FS_DENIED';
    default:
      return 'FS_IO';
  }
}

/**
 * basename 合法性校验。renderer 传来的 newName 必须是单段名,
 * 不能含路径分隔符,不能是 . / ..(防越级越权)。
 */
export function assertValidBasename(name: string): void {
  if (!name || name === '.' || name === '..') {
    throw fsError('FS_BAD_NAME', `invalid name: "${name}"`);
  }
  if (name.includes('/') || name.includes('\\')) {
    throw fsError('FS_BAD_NAME', `name must not contain path separator: "${name}"`);
  }
}
