// race(R27,R18/R19 同族收口):workspace root 的所有「异步选择」入口(drop / 打开最近 /
// EmptyWorkspace 打开 / ExplorerHeader 切换)必须共用同一个「最新者胜」守卫
// workspaceRootSelectionGuard,使任一入口发起的新选择都作废其它入口在途的选择。
// 此前守卫按入口分裂:拖入 A 未完成时点最近 B 切成功,A 迟到 resolve 仍 setRoot(A) 打开错误
// workspace 并触发持久化写错 root。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listDir = vi.fn();
vi.mock('@/lib/co-api', () => ({
  coApi: { fs: { listDir: (...a: unknown[]) => listDir(...a) } },
}));
const notifyError = vi.fn();
vi.mock('@/notifications/notify', () => ({
  notify: { error: (...a: unknown[]) => notifyError(...a) },
}));
vi.mock('@/lib/localize-error', () => ({
  localizeErrorByCode: (_code: string, msg: string) => msg,
}));

import { openRecentRootOrNotify } from '../../panels/Explorer/open-recent-root';
import {
  workspaceRootSelectionGuard,
  cancelPendingWorkspaceRootSelection,
} from '../../lib/workspace-root-guard';

beforeEach(() => {
  listDir.mockReset();
  notifyError.mockReset();
});

describe('workspaceRootSelectionGuard — 跨入口共享(R27)', () => {
  it('openRecent 在途时另一入口 begin() → openRecent 结果被丢弃(证明 recent 用共享守卫)', async () => {
    let resolveListDir!: (v: unknown) => void;
    listDir.mockImplementation(
      () =>
        new Promise((res) => {
          resolveListDir = res;
        }),
    );
    const setRoot = vi.fn();

    const p = openRecentRootOrNotify('/A', setRoot); // 发起「打开最近」,begin() on 共享守卫
    // 模拟另一个 root 选择入口(drop / 原生对话框)发起 → 共享守卫 begin() 使 A 过期。
    workspaceRootSelectionGuard.begin();
    resolveListDir({ ok: true, data: [] }); // A 的 listDir 迟到成功
    await p;

    // 若 recent 仍用私有守卫,外部 begin() 不会作废它 → setRoot 会被调用(回归)。
    expect(setRoot).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
  });

  // race(R28):同步 root 变更(关闭文件夹)前调 cancelPendingWorkspaceRootSelection() 作废在途选择,
  // 否则迟到的 open/recent resolve 仍 setRoot(oldPath) 撤销关闭。
  it('cancelPendingWorkspaceRootSelection() 作废在途 openRecent(同步关闭场景)', async () => {
    let resolveListDir!: (v: unknown) => void;
    listDir.mockImplementation(
      () =>
        new Promise((res) => {
          resolveListDir = res;
        }),
    );
    const setRoot = vi.fn();
    const p = openRecentRootOrNotify('/A', setRoot);
    cancelPendingWorkspaceRootSelection(); // 模拟「关闭文件夹」同步变更前作废在途
    resolveListDir({ ok: true, data: [] });
    await p;
    expect(setRoot).not.toHaveBeenCalled();
  });

  it('openRecent 期间无其它入口介入 → 正常 setRoot(控制组)', async () => {
    listDir.mockResolvedValue({ ok: true, data: [] });
    const setRoot = vi.fn();
    await openRecentRootOrNotify('/solo', setRoot);
    expect(setRoot).toHaveBeenCalledWith('/solo');
  });

  it('openRecent 失败(!ok)在途被其它入口 begin() 作废 → 连 notify.error 都不报(过期请求静默)', async () => {
    let resolveListDir!: (v: unknown) => void;
    listDir.mockImplementation(
      () =>
        new Promise((res) => {
          resolveListDir = res;
        }),
    );
    const setRoot = vi.fn();
    const p = openRecentRootOrNotify('/gone', setRoot);
    workspaceRootSelectionGuard.begin(); // 另一入口接管
    resolveListDir({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' });
    await p;
    expect(setRoot).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled(); // 由最新入口负责反馈,过期请求不抢报
  });
});
