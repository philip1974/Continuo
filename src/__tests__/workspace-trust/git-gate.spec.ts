// BDD: workspace-trust / 受限模式不跑 git:git:status 在未受信任的文件夹里不调用任何 git 子进程(exec 探针零调用),回 null;
// 信任后同一窗口即时照常运行;根不符照旧 STALE。
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent', on: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(), fromId: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
}));

import { gateGitByWorkspaceTrust } from '../../../electron/main/ipc/git.ipc';
import { createGitStatusService, makeGitStatusHandler } from '../../../electron/main/services/git-status.service';
import { createWorkspaceTrustService } from '../../../electron/main/services/workspace-trust.service';
import { GIT_STATUS_STALE } from '../../../electron/shared/git-status';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('受限模式下 git 装饰不运行 git', () => {
  it('未受信任 → exec 探针零调用、回 null;管理里信任后 → 同一窗口立即运行 git', async () => {
    const exec = vi.fn(async () => '');
    const roots = new Map<number, string>([[1, '/work/proj']]);
    const getRoot = (id: number) => roots.get(id) ?? null;
    let answer = { trust: false, parent: false };
    const trust = createWorkspaceTrustService({
      enabled: true,
      load: async () => null,
      save: async () => undefined,
      realpath: async (p) => p,
      platform: 'linux',
      prompt: async () => answer,
      push: () => undefined,
    });
    const handle = gateGitByWorkspaceTrust(
      makeGitStatusHandler(createGitStatusService(exec), getRoot),
      getRoot,
      (id, root) => trust.isWindowTrusted(id, root),
    );
    const win = { id: 1 };

    trust.setWindowRoot(1, '/work/proj');
    await flush();
    // 未信任(启动询问选了「不信任」):多次查询都不跑 git
    expect(await handle(win, '/work/proj')).toBeNull();
    expect(await handle(win, '/work/proj')).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    // 根不符:照旧 STALE(也不跑 git)
    expect(await handle(win, '/elsewhere')).toEqual(GIT_STATUS_STALE);
    expect(exec).not.toHaveBeenCalled();

    // 管理工作区信任 →「信任」(原生对话框里选信任)
    answer = { trust: true, parent: false };
    expect(await trust.requestTrust(1)).toBe(true);
    await handle(win, '/work/proj');
    expect(exec).toHaveBeenCalled();
    expect(exec.mock.calls.every((c) => (c as unknown[])[1] === '/work/proj')).toBe(true);
  });

  it('信任状态尚未求出(realpath 进行中)时等它求出,不抢跑 git', async () => {
    const exec = vi.fn(async () => '');
    let resolveReal!: (p: string) => void;
    const trust = createWorkspaceTrustService({
      enabled: true,
      load: async () => ({ trusted: [], prompted: ['/work/proj'] }),
      save: async () => undefined,
      realpath: () => new Promise<string>((r) => (resolveReal = r)),
      platform: 'linux',
      prompt: async () => null,
      push: () => undefined,
    });
    const getRoot = () => '/work/proj';
    const handle = gateGitByWorkspaceTrust(
      makeGitStatusHandler(createGitStatusService(exec), getRoot),
      getRoot,
      (id, root) => trust.isWindowTrusted(id, root),
    );
    trust.setWindowRoot(1, '/work/proj');
    const pending = handle({ id: 1 }, '/work/proj');
    await flush();
    resolveReal('/work/proj');
    expect(await pending).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});
