// BDD(main 侧):工作区根自身被改名 / 删除时,fs.watch 只回调一次、filename = 根的 basename(macOS 递归 FSEvents、
// Linux inotify 的 IN_MOVE_SELF / IN_DELETE_SELF);Windows 删除被 watch 的目录则 FSWatcher emit('error')(EPERM)。
// 此时 main stat 根:不存在 → 广播 fs:root-presence-changed({ path },不带文件名);之后根重新出现(改回原名 / 重建)
// 的同一回调 → 再广播一次,渲染端据此复查根下 tab。根仍在(如根下恰有同名子项变化)且此前未消失 → 不广播。
// 卷卸载 / 挂回(dmg、U 盘):根事件与卷实际状态不同步 → 每次根事件后延迟复查一次(见 ROOT_PRESENCE_SETTLE_MS);
// 不带 filename 的根级事件同样当作根事件。
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

describe('卷卸载 / 挂回:根事件后延迟复查', () => {
  // 手动定时器:收集延迟复查,按需触发。
  const timers: Array<() => void> = [];
  const schedule = (fn: () => void) => {
    timers.push(fn);
  };
  const runTimers = () => {
    for (const fn of timers.splice(0)) fn();
  };
  afterEach(() => {
    timers.length = 0;
  });

  it('卸载事件先于挂载点消失到达(事件当下仍存在)→ 延迟复查发现消失,通知', async () => {
    let exists: boolean | null = true;
    const onChange = vi.fn();
    const check = createRootPresenceTracker({ isRoot: () => true, exists: async () => exists, onChange, schedule });
    check('/Volumes/X');
    await settle();
    expect(onChange).not.toHaveBeenCalled();
    exists = false;
    runTimers();
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('挂回:事件当下(空挂载点)判为恢复 → 通知;延迟复查(卷内容就位)再通知一次;之后不再通知', async () => {
    let exists: boolean | null = false;
    const onChange = vi.fn();
    const check = createRootPresenceTracker({ isRoot: () => true, exists: async () => exists, onChange, schedule });
    check('/Volumes/X');
    await settle();
    runTimers();
    await settle();
    expect(onChange).toHaveBeenCalledTimes(2); // 消失:事件当下 + 延迟复查各一次
    exists = true;
    check('/Volumes/X');
    await settle();
    expect(onChange).toHaveBeenCalledTimes(3);
    runTimers();
    await settle();
    expect(onChange).toHaveBeenCalledTimes(4);
    check('/Volumes/X');
    await settle();
    runTimers();
    await settle();
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('同一根的连串事件只排一个延迟复查', async () => {
    const onChange = vi.fn();
    const check = createRootPresenceTracker({ isRoot: () => true, exists: async () => true, onChange, schedule });
    check('/w');
    check('/w');
    check('/w');
    expect(timers).toHaveLength(1);
    runTimers();
    check('/w');
    expect(timers).toHaveLength(1);
  });

  it('延迟复查时已不是工作区根 → 不查不通知', async () => {
    let root = true;
    const exists = vi.fn(async () => false);
    const onChange = vi.fn();
    const check = createRootPresenceTracker({ isRoot: () => root, exists, onChange, schedule });
    check('/w');
    await settle();
    root = false;
    runTimers();
    await settle();
    expect(exists).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
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

  it('根级事件不带 filename(平台未给)且根已不存在 → 同样广播', async () => {
    const { createFsWatcher } = await import('../../../electron/main/ipc/fs.ipc');
    const { setWorkspaceRoot } = await import('../../../electron/main/services/window-workspace-roots.service');
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '__no_such_root_nofile__');
    setWorkspaceRoot(904, root);
    try {
      const onChange = vi.fn();
      createFsWatcher(root, onChange, vi.fn());
      mocks.watchers[0]!.cb('rename', null);
      await settle();
      expect(onChange).toHaveBeenCalledWith(root);
      expect(rootPresenceSends()).toEqual([['fs:root-presence-changed', { path: root }]]);
    } finally {
      setWorkspaceRoot(904, null);
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
