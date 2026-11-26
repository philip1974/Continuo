// @vitest-environment jsdom
// a11y(A147):openRecentRootOrNotify —— 点最近目录前 listDir 校验,失效则 notify.error 不切 root。
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

const focusOther = vi.fn(async (_p: string) => false);
vi.mock('@/lib/focus-workspace-window', () => ({
  focusWindowIfWorkspaceOpen: (p: string) => focusOther(p),
}));
const requestExplorer = vi.fn();
vi.mock('@/panels/Explorer/explorer-requests', () => ({
  requestExplorer: (...a: unknown[]) => requestExplorer(...a),
}));

import { focusTreeAfterRootSwitch, openRecentRootOrNotify } from '../../panels/Explorer/open-recent-root';
import { useWorkspaceStore } from '../../stores/workspace.store';

beforeEach(() => {
  listDir.mockReset();
  notifyError.mockReset();
  focusOther.mockReset();
  focusOther.mockResolvedValue(false);
  requestExplorer.mockReset();
  document.body.innerHTML = '';
});

describe('openRecentRootOrNotify (A147)', () => {
  it('listDir ok → setRoot(path),不 notify', async () => {
    listDir.mockResolvedValue({ ok: true, data: [] });
    const setRoot = vi.fn();
    await openRecentRootOrNotify('/proj', setRoot);
    expect(setRoot).toHaveBeenCalledWith('/proj');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('perf · 可访问性探测只看 ok,传 withStats:false(main 免逐项 lstat)', async () => {
    listDir.mockResolvedValue({ ok: true, data: [] });
    await openRecentRootOrNotify('/proj', vi.fn());
    expect(listDir).toHaveBeenCalledWith('/proj', { withStats: false });
  });

  it('listDir {ok:false} → notify.error 不 setRoot', async () => {
    listDir.mockResolvedValue({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' });
    const setRoot = vi.fn();
    await openRecentRootOrNotify('/stale', setRoot);
    expect(setRoot).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(String(notifyError.mock.calls[0]![0])).toContain('gone');
  });

  it('目录已不存在(FS_NOT_FOUND / WORKSPACE_NOT_FOUND)且传了 onMissing → 交给 onMissing(询问是否从列表移除),不弹 toast', async () => {
    const setRoot = vi.fn();
    const onMissing = vi.fn();
    listDir.mockResolvedValue({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' });
    await openRecentRootOrNotify('/stale', setRoot, onMissing);
    listDir.mockResolvedValue({ ok: false, code: 'WORKSPACE_NOT_FOUND', message: 'gone' });
    await openRecentRootOrNotify('/stale2', setRoot, onMissing);
    expect(onMissing.mock.calls.map((c) => c[0])).toEqual(['/stale', '/stale2']);
    expect(notifyError).not.toHaveBeenCalled();
    expect(setRoot).not.toHaveBeenCalled();
  });

  it('其它失败(如 FS_DENIED)即使传了 onMissing 仍 toast', async () => {
    const onMissing = vi.fn();
    listDir.mockResolvedValue({ ok: false, code: 'FS_DENIED', message: 'denied' });
    await openRecentRootOrNotify('/locked', vi.fn(), onMissing);
    expect(onMissing).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledTimes(1);
  });

  it('listDir reject → notify.error 不 setRoot(不抛)', async () => {
    listDir.mockRejectedValue(Object.assign(new Error('ipc down'), { code: 'EIO' }));
    const setRoot = vi.fn();
    await expect(openRecentRootOrNotify('/x', setRoot)).resolves.toBeUndefined();
    expect(setRoot).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(String(notifyError.mock.calls[0]![0])).toContain('ipc down');
  });

  // race(R19,R18 同族):连点最近目录 A→B,A 的 listDir 迟到成功不得乱序覆盖后选的 B(latest 守卫)。
  it('R19 连点 A→B,A 探测迟到 resolve → 只 setRoot(B)', async () => {
    let resolveA!: (v: unknown) => void;
    let resolveB!: (v: unknown) => void;
    listDir.mockImplementation((p: string) =>
      p === '/A'
        ? new Promise((res) => {
            resolveA = res;
          })
        : new Promise((res) => {
            resolveB = res;
          }),
    );
    const setRoot = vi.fn();

    const pA = openRecentRootOrNotify('/A', setRoot); // 先发起
    const pB = openRecentRootOrNotify('/B', setRoot); // 后发起 = 最新

    resolveB({ ok: true, data: [] }); // B 先 resolve → setRoot(B)
    await pB;
    resolveA({ ok: true, data: [] }); // A 后 resolve(过期)→ 不 setRoot
    await pA;

    expect(setRoot).toHaveBeenCalledTimes(1);
    expect(setRoot).toHaveBeenCalledWith('/B');
  });
});

// VSCode:从「最近打开」切换文件夹后焦点在资源管理器。触发按钮(标题栏「更多操作」/ 空态的最近项)随 root 变化卸载,
// 此前焦点落到 body 并一直停在那里。切换后把焦点交给新 root 的文件树(同「打开文件夹」的 focusTree 请求),但只在焦点
// 仍在侧栏里或已丢失时(focusWithinOrLost:等待探测期间用户把焦点移到编辑器等别处 → 不抢)。
describe('切换后焦点交给新 root 的文件树', () => {
  function mount(): { sidebarButton: HTMLButtonElement; editor: HTMLTextAreaElement } {
    document.body.innerHTML =
      '<div data-workbench-part="sidebar"><button>more</button></div><div data-workbench-part="dock"><textarea></textarea></div>';
    return {
      sidebarButton: document.querySelector('button')!,
      editor: document.querySelector('textarea')!,
    };
  }
  const setRootInStore = (p: string) => useWorkspaceStore.getState().setRoot(p);

  it('焦点在侧栏里(触发按钮)→ setRoot 后请求 focusTree(新 root)', async () => {
    mount().sidebarButton.focus();
    listDir.mockResolvedValue({ ok: true, data: [] });
    await openRecentRootOrNotify('/proj-a', setRootInStore);
    expect(requestExplorer).toHaveBeenCalledWith({ kind: 'focusTree', root: '/proj-a' });
  });

  it('焦点已丢失(body)→ 同样请求 focusTree', async () => {
    mount();
    (document.activeElement as HTMLElement | null)?.blur();
    listDir.mockResolvedValue({ ok: true, data: [] });
    await openRecentRootOrNotify('/proj-b', setRootInStore);
    expect(requestExplorer).toHaveBeenCalledWith({ kind: 'focusTree', root: '/proj-b' });
  });

  it('等待探测期间焦点被移到编辑器 → 不抢焦点', async () => {
    const { editor } = mount();
    listDir.mockImplementation(async () => {
      editor.focus();
      return { ok: true, data: [] };
    });
    await openRecentRootOrNotify('/proj-c', setRootInStore);
    expect(useWorkspaceStore.getState().root).toBe('/proj-c');
    expect(requestExplorer).not.toHaveBeenCalled();
  });

  it('该文件夹已在别的窗口打开(聚焦那个窗口)/ 探测失败 → 不动本窗口焦点', async () => {
    mount().sidebarButton.focus();
    listDir.mockResolvedValue({ ok: true, data: [] });
    focusOther.mockResolvedValue(true);
    await openRecentRootOrNotify('/elsewhere', setRootInStore);
    listDir.mockResolvedValue({ ok: false, code: 'FS_DENIED', message: 'denied' });
    await openRecentRootOrNotify('/locked', setRootInStore);
    expect(requestExplorer).not.toHaveBeenCalled();
  });

  it('focusTreeAfterRootSwitch:没有 root(关闭文件夹)→ 不请求', () => {
    mount();
    useWorkspaceStore.getState().setRoot(null);
    focusTreeAfterRootSwitch();
    expect(requestExplorer).not.toHaveBeenCalled();
  });
});
