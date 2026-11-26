// renderer 在本窗口打开文件夹的入口:先问 main 该文件夹是否已在别的主窗口打开(是 → main 已聚焦那个窗口,
// 本窗口 root 不变);否则照常切换。IPC 失败按「没在别处打开」处理,打开文件夹本身不失效。
// (拖文件夹进窗口的入口见 window-drop/explorer-vs-window-folder-drop.spec.tsx。)
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listDir: vi.fn(),
  selectDirectory: vi.fn(),
  focusWorkspaceWindow: vi.fn(),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: { listDir: h.listDir, selectDirectory: h.selectDirectory },
    window: { focusWorkspaceWindow: h.focusWorkspaceWindow },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: vi.fn(), info: vi.fn() } }));

import { openRecentRootOrNotify } from '../../panels/Explorer/open-recent-root';
import { selectWorkspaceFolder } from '../../panels/Explorer/hooks/useSelectWorkspaceFolder';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { workspaceRootSelectionGuard } from '@/lib/workspace-root-guard';

beforeEach(() => {
  vi.clearAllMocks();
  h.listDir.mockResolvedValue({ ok: true, data: [] });
  h.focusWorkspaceWindow.mockResolvedValue({ ok: true, data: false });
  useWorkspaceStore.setState({ root: null });
});

describe('最近打开', () => {
  it('已在别的窗口打开 → 不改本窗口 root', async () => {
    h.focusWorkspaceWindow.mockResolvedValue({ ok: true, data: true });
    const setRoot = vi.fn();
    await openRecentRootOrNotify('/u/ws-x', setRoot);
    expect(h.focusWorkspaceWindow).toHaveBeenCalledWith('/u/ws-x');
    expect(setRoot).not.toHaveBeenCalled();
  });

  it('没在别处打开 → 照常 setRoot', async () => {
    const setRoot = vi.fn();
    await openRecentRootOrNotify('/u/ws-x', setRoot);
    expect(setRoot).toHaveBeenCalledWith('/u/ws-x');
  });

  it('询问失败(reject / ok:false)→ 照常 setRoot', async () => {
    const setRoot = vi.fn();
    h.focusWorkspaceWindow.mockRejectedValueOnce(new Error('ipc gone'));
    await openRecentRootOrNotify('/u/a', setRoot);
    h.focusWorkspaceWindow.mockResolvedValueOnce({ ok: false, code: 'NO_WINDOW', message: 'x' });
    await openRecentRootOrNotify('/u/b', setRoot);
    expect(setRoot.mock.calls.map((c) => c[0])).toEqual(['/u/a', '/u/b']);
  });

  it('询问期间又发起了新的选择 → 本次作废,不 setRoot', async () => {
    let resolve!: (v: unknown) => void;
    h.focusWorkspaceWindow.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const setRoot = vi.fn();
    const p = openRecentRootOrNotify('/u/old', setRoot);
    await vi.waitFor(() => expect(h.focusWorkspaceWindow).toHaveBeenCalled());
    workspaceRootSelectionGuard.begin();
    resolve({ ok: true, data: false });
    await p;
    expect(setRoot).not.toHaveBeenCalled();
  });
});

describe('打开文件夹…(含 ⌘O 命令)', () => {
  it('选中的文件夹已在别的窗口打开 → 本窗口 root 不变,不触发 onSelected', async () => {
    h.selectDirectory.mockResolvedValue({ ok: true, data: '/u/ws-x' });
    h.focusWorkspaceWindow.mockResolvedValue({ ok: true, data: true });
    useWorkspaceStore.setState({ root: '/u/ws-a' });
    const onSelected = vi.fn();
    await selectWorkspaceFolder({ onSelected });
    expect(h.focusWorkspaceWindow).toHaveBeenCalledWith('/u/ws-x');
    expect(useWorkspaceStore.getState().root).toBe('/u/ws-a');
    expect(onSelected).not.toHaveBeenCalled();
  });

  it('没在别处打开 → 切到该文件夹', async () => {
    h.selectDirectory.mockResolvedValue({ ok: true, data: '/u/ws-x' });
    const onSelected = vi.fn();
    await selectWorkspaceFolder({ onSelected });
    expect(useWorkspaceStore.getState().root).toBe('/u/ws-x');
    expect(onSelected).toHaveBeenCalledTimes(1);
  });
});
