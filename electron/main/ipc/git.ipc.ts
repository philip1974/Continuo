// 资源管理器 git 状态装饰的 IPC 接线:git:status 走 safeHandle 管线(frame 信任 + zod),根取自发送窗口的工作区登记
//(入参的 root 只用来与登记根比对,不符 → STALE)。
// 工作区信任:本窗口文件夹未受信任(受限模式)→ 不跑任何 git 子进程,回 null(无装饰);信任状态未求出时等它求出;
// 信任服务未注册 → 同样按不受信任处理(fail-closed)。VSCode 受限模式下 git 扩展不激活(不支持不受信任的工作区)。
// 逻辑在 services/git-status.service(可单测)。BDD: src/__tests__/explorer-git-decorations/、src/__tests__/workspace-trust/

import { z } from 'zod';
import { safeHandleWithWindow } from '../safe-handle';
import { ERROR_CODES } from '../../shared/error-codes';
import { GIT_CHANNELS, type GitStatusResult } from '../../shared/git-status';
import { ROOT_MAX } from '../../shared/window-create-schema';
import { getWorkspaceRoot } from '../services/window-workspace-roots.service';
import { createGitStatusService, makeGitStatusHandler } from '../services/git-status.service';
import { getWorkspaceTrust } from './workspace-trust.ipc';

/** renderer 当前的工作区根(只与登记根比对,不作 cwd)。 */
const StatusInput = z.object({ root: z.string().min(1).max(ROOT_MAX) });

type GitHandler = (win: { readonly id: number }, expectedRoot: string) => Promise<GitStatusResult>;

/** 在 git 处理前按工作区信任把关:根不符照旧交给原处理(STALE);未受信任 → null,不调用原处理(不跑 git)。 */
export function gateGitByWorkspaceTrust(
  handle: GitHandler,
  getRoot: (windowId: number) => string | null,
  isTrusted: (windowId: number, root: string) => Promise<boolean>,
): GitHandler {
  return async (win, expectedRoot) => {
    if (getRoot(win.id) !== expectedRoot) return handle(win, expectedRoot);
    return (await isTrusted(win.id, expectedRoot)) ? handle(win, expectedRoot) : null;
  };
}

export function registerGitIpc(): void {
  const handle = gateGitByWorkspaceTrust(
    makeGitStatusHandler(createGitStatusService(), getWorkspaceRoot),
    getWorkspaceRoot,
    async (windowId, root) => (await getWorkspaceTrust()?.isWindowTrusted(windowId, root)) ?? false,
  );
  safeHandleWithWindow(GIT_CHANNELS.STATUS, StatusInput, (input, win) => handle(win, input.root), ERROR_CODES.NO_WINDOW);
}
