// 资源管理器 git 状态装饰的 IPC 接线:git:status 走 safeHandle 管线(frame 信任 + zod),根取自发送窗口的工作区登记。
// 逻辑在 services/git-status.service(可单测)。BDD: src/__tests__/explorer-git-decorations/

import { z } from 'zod';
import { safeHandleWithWindow } from '../safe-handle';
import { ERROR_CODES } from '../../shared/error-codes';
import { GIT_CHANNELS } from '../../shared/git-status';
import { getWorkspaceRoot } from '../services/window-workspace-roots.service';
import { createGitStatusService, makeGitStatusHandler } from '../services/git-status.service';

export function registerGitIpc(): void {
  const handle = makeGitStatusHandler(createGitStatusService(), getWorkspaceRoot);
  safeHandleWithWindow(GIT_CHANNELS.STATUS, z.undefined(), (_input, win) => handle(win), ERROR_CODES.NO_WINDOW);
}
