// 永久删除(资源管理器「无法移到废纸篓,是否永久删除?」确认后的出路,对齐 VSCode fileActions.deleteFiles 的
// trashFailed → Delete Permanently)。不可撤销:只在用户于确认框里明确选择后由 renderer 调用。
// - 不跟随符号链接:fs.rm 对链接只删链接本身(lstat 语义),目录递归时同样不进入链接目标。
// - 拒绝文件系统根与任一窗口的工作区根(误删整个工作区 / 磁盘的兜底;资源管理器里根本身不提供删除)。
// - E2E 模式(CONTINUO_E2E=1)只允许系统临时目录内的路径(e2e 夹具都建在 os.tmpdir() 下),绝不碰其它真实数据。
// BDD: src/__tests__/explorer-trash-failure/
import { realpath, rm, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ERROR_CODES } from '../../../shared/error-codes';
import { isSameOrInsidePath } from '../../lib/path-inside';
import { fsError, mapNodeErrnoCode } from './path-utils';

export interface DeletePermanentlyDeps {
  /** 是否某窗口的工作区根(拒绝删除)。 */
  readonly isWorkspaceRoot: (p: string) => boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** E2E 模式下允许的根(缺省 os.tmpdir())。 */
  readonly e2eAllowedRoot?: string;
}

export async function deletePermanently(target: string, deps: DeletePermanentlyDeps): Promise<void> {
  const abs = path.resolve(target);
  if (path.parse(abs).root === abs || deps.isWorkspaceRoot(abs)) {
    throw fsError(ERROR_CODES.FS_DENIED, 'refusing to delete a file system or workspace root');
  }
  try {
    await lstat(abs);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `lstat failed: ${abs}`);
  }
  if (deps.env['CONTINUO_E2E'] === '1') {
    // 父目录 realpath 后判断(目标本身可能是链接,不解析它):防经链接把临时目录外的路径伪装进来。
    const allowed = await realpath(deps.e2eAllowedRoot ?? os.tmpdir()).catch(() => null);
    const parent = await realpath(path.dirname(abs)).catch(() => null);
    if (allowed === null || parent === null || !isSameOrInsidePath(allowed, parent)) {
      throw fsError(ERROR_CODES.FS_DENIED, 'E2E mode: permanent delete is limited to the temp directory');
    }
  }
  try {
    await rm(abs, { recursive: true, force: false });
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `delete failed: ${abs}`);
  }
}
