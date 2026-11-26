// 资源管理器 git 状态装饰的 IPC 接线:git:status 走 safeHandle 管线(frame 信任 + zod),根取自发送窗口的工作区登记
//(入参的 root 只用来与登记根比对,不符 → STALE)。
// 逻辑在 services/git-status.service(可单测)。BDD: src/__tests__/explorer-git-decorations/

import { z } from 'zod';
import { safeHandleWithWindow } from '../safe-handle';
import { ERROR_CODES } from '../../shared/error-codes';
import { GIT_CHANNELS } from '../../shared/git-status';
import { ROOT_MAX } from '../../shared/window-create-schema';
import { getWorkspaceRoot } from '../services/window-workspace-roots.service';
import { createGitStatusService, makeGitStatusHandler } from '../services/git-status.service';

/** renderer 当前的工作区根(只与登记根比对,不作 cwd)。 */
const StatusInput = z.object({ root: z.string().min(1).max(ROOT_MAX) });

export function registerGitIpc(): void {
  const handle = makeGitStatusHandler(createGitStatusService(), getWorkspaceRoot);
  safeHandleWithWindow(GIT_CHANNELS.STATUS, StatusInput, (input, win) => handle(win, input.root), ERROR_CODES.NO_WINDOW);
}
