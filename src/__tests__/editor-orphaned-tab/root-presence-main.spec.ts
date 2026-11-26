// BDD(main 侧):工作区根自身被改名 / 删除时,fs.watch 只回调一次、filename = 根的 basename(macOS 递归 FSEvents、
// Linux inotify 的 IN_MOVE_SELF / IN_DELETE_SELF);Windows 删除被 watch 的目录则 FSWatcher emit('error')(EPERM)。
// 此时 main stat 根:不存在 → 广播 fs:root-presence-changed({ path },不带文件名);之后根重新出现(改回原名 / 重建)
// 的同一回调 → 再广播一次,渲染端据此复查根下 tab。根仍在(如根下恰有同名子项变化)且此前未消失 → 不广播。
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRootPresenceTracker } from '../../../electron/main/ipc/fs/watch';

const mocks = vi.hoisted(() => ({
  watchers: [] as Array<EventEmitter & { close: () => void; cb: (e: string, f: string | null) => void }>,
  sends: [] as Array<[string, unknown]>,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (ch: string, p: unknown) => mocks.sends.push([ch, p]) } },
    ],
    fromId: () => null,
  },
  app: {},
  dialog: {},
  shell: {},
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const watch = vi.fn((_p: string, _o: unknown, cb: (e: string, f: string | null) => void) => {
    const w = Object.assign(new EventEmitter(), { close: vi.fn(), cb });
    mocks.watchers.push(w);
    return w;
  });
  return { ...actual, default: { ...actual, watch }, watch };
});

afterEach(() => {
  mocks.watchers = [];
  mocks.sends = [];
  vi.spyOn(console, 'warn').mockRestore();
});

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('createRootPresenceTracker', () => {
  it('不存在 → 通知;仍不存在再报 → 再通知;重新出现 → 通知一次;此后存在 → 不通知', async () => {
    let exists: boolean | null = false;
    const onChange = vi.fn();
    const check = createRootPresenceTracker({ isRoot: () => true, exists: async () => exists, onChange });
    check('/w');
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    exists = true;
    check('/w');
    await settle();
    check('/w');
    await settle();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith('/w');
  });

  it('不是工作区根 / 无法确定(null)→ 不通知', async () => {
    const onChange = vi.fn();
    createRootPresenceTracker({ isRoot: () => false, exists: async () => false, onChange })('/w');
    createRootPresenceTracker({ isRoot: () => true, exists: async () => null, onChange })('/w');
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('生产 watcher 接线', () => {
  const rootPresenceSends = () => mocks.sends.filter(([ch]) => ch === 'fs:root-presence-changed');

  it('filename = 根 basename 且根已不存在 → 广播 { path }(不带文件名)', async () => {
    const { createFsWatcher } = await import('../../../electron/main/ipc/fs.ipc');
    const { setWorkspaceRoot } = await import('../../../electron/main/services/window-workspace-roots.service');
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '__no_such_root__');
    setWorkspaceRoot(901, root);
    try {
      createFsWatcher(root, vi.fn(), vi.fn());
      mocks.watchers[0]!.cb('rename', path.basename(root));
      await settle();
      expect(rootPresenceSends()).toEqual([['fs:root-presence-changed', { path: root }]]);
    } finally {
      setWorkspaceRoot(901, null);
    }
  });

  it('根仍存在(根下同名子项变化)→ 不广播', async () => {
    const { createFsWatcher } = await import('../../../electron/main/ipc/fs.ipc');
    const { setWorkspaceRoot } = await import('../../../electron/main/services/window-workspace-roots.service');
    const root = path.dirname(fileURLToPath(import.meta.url));
    setWorkspaceRoot(902, root);
    try {
      createFsWatcher(root, vi.fn(), vi.fn());
      mocks.watchers[0]!.cb('rename', path.basename(root));
      await settle();
      expect(rootPresenceSends()).toEqual([]);
    } finally {
      setWorkspaceRoot(902, null);
    }
  });

  it('watcher error(Windows 删除被 watch 的根:EPERM)且根已不存在 → 同样广播', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createFsWatcher } = await import('../../../electron/main/ipc/fs.ipc');
    const { setWorkspaceRoot } = await import('../../../electron/main/services/window-workspace-roots.service');
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '__no_such_root_err__');
    setWorkspaceRoot(903, root);
    try {
      const onError = vi.fn();
      createFsWatcher(root, vi.fn(), onError);
      mocks.watchers[0]!.emit('error', Object.assign(new Error('EPERM'), { code: 'EPERM' }));
      await settle();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(rootPresenceSends()).toEqual([['fs:root-presence-changed', { path: root }]]);
    } finally {
      setWorkspaceRoot(903, null);
    }
  });
});
