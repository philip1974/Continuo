// BDD(main 侧):卷挂在固定目录上(`hdiutil attach -mountpoint <dir>`、NFS / SMB / sshfs 挂在用户目录下),卸载 / 挂回时
// 根路径一直存在(卸载后露出空的挂载点目录),只有根目录的 dev / ino 变。此时:
// - 根检查(根事件当下 / 延迟复查 / 窗口获焦)比对 dev / ino,与上次看到的不同 → 广播 fs:root-presence-changed(资源管理器整树刷新),
//   并在延迟复查时再广播一次(卷内容就位);首次看到的身份只作基线,不广播;
// - 同时重建该根(含其下已展开目录)的 watcher:卷换了,旧 watcher 可能已失效;重建失败 → 按失效驱逐通知持有者重装。
// 行为见同目录 README。被测:electron/main/ipc/fs/watch.ts(createRootPresenceTracker / createWatcherPool.recreate)、
// electron/main/ipc/fs.ipc.ts(生产接线)。真实 dmg 见 tests/e2e/explorer-volume-unmount.spec.ts「固定挂载点」。
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FS_CHANNELS } from '../../../electron/shared/fs-channels';
import { createRootPresenceTracker, createWatcherPool, type Watcher } from '../../../electron/main/ipc/fs/watch';

const m = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  sends: [] as Array<[string, unknown]>,
  watched: [] as Array<{ path: string; close: ReturnType<typeof vi.fn> }>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, h: (event: unknown, raw: unknown) => Promise<unknown>) => m.handlers.set(channel, h),
  },
  BrowserWindow: {
    fromWebContents: () => ({ id: 7 }),
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (ch: string, p: unknown) => m.sends.push([ch, p]) } },
    ],
    fromId: () => null,
  },
  app: { getPath: () => tmpdir() },
  dialog: {},
  shell: {},
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const watch = vi.fn((p: string) => {
    const close = vi.fn();
    m.watched.push({ path: String(p), close });
    return Object.assign(new EventEmitter(), { close });
  });
  return { ...actual, default: { ...actual, watch }, watch };
});

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('createRootPresenceTracker:根身份(dev:ino)比对', () => {
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

  it('首次看到的身份只作基线;身份变了(卸载露出挂载点目录)→ onReplaced + 通知,延迟复查再通知一次;之后不变 → 不通知', async () => {
    let id: string | boolean | null = '1:2';
    const onChange = vi.fn();
    const onReplaced = vi.fn();
    const check = createRootPresenceTracker({ isRoot: () => true, exists: async () => id, onChange, onReplaced, schedule });
    check('/mnt/vol');
    await settle();
    runTimers();
    await settle();
    expect(onChange).not.toHaveBeenCalled();

    id = '9:77'; // 卸载:同一路径变成父卷上的空目录
    check('/mnt/vol');
    await settle();
    expect(onReplaced).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    runTimers();
    await settle();
    expect(onChange).toHaveBeenCalledTimes(2);

    check('/mnt/vol');
    await settle();
    runTimers();
    await settle();
    expect(onChange).toHaveBeenCalledTimes(2);

    id = '1:2'; // 挂回:身份回到卷根(同一个 dev 号也算变 —— 与上次看到的不同)
    check('/mnt/vol');
    await settle();
    expect(onReplaced).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('prime 只记基线:不通知;之后身份变了 → 通知', async () => {
    let id = '1:2';
    const onChange = vi.fn();
    const check = createRootPresenceTracker({ isRoot: () => true, exists: async () => id, onChange, schedule });
    check.prime('/mnt/vol');
    await settle();
    expect(onChange).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
    id = '9:9';
    check('/mnt/vol');
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('只在延迟复查时才看到新身份 → 通知一次', async () => {
    let id = '1:2';
    const onChange = vi.fn();
    const check = createRootPresenceTracker({ isRoot: () => true, exists: async () => id, onChange, schedule });
    check('/mnt/vol');
    await settle();
    id = '3:4';
    runTimers();
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('身份未知(只给 true)/ 无法确定(null)→ 不按身份判变化', async () => {
    const answers: Array<string | boolean | null> = ['1:2', true, null, '1:2'];
    const onChange = vi.fn();
    const check = createRootPresenceTracker({
      isRoot: () => true,
      exists: async () => answers.shift() ?? '1:2',
      onChange,
      schedule,
    });
    for (let i = 0; i < 4; i++) {
      check('/w');
      await settle();
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('消失后以新身份恢复 → onReplaced(重建 watcher)+ 通知', async () => {
    let id: string | boolean = '1:2';
    const onChange = vi.fn();
    const onReplaced = vi.fn();
    const check = createRootPresenceTracker({ isRoot: () => true, exists: async () => id, onChange, onReplaced, schedule });
    check('/Volumes/X');
    await settle();
    id = false;
    check('/Volumes/X');
    await settle();
    expect(onReplaced).not.toHaveBeenCalled();
    id = '5:2';
    check('/Volumes/X');
    await settle();
    expect(onReplaced).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('createWatcherPool.recreate:按原路径重建 watcher', () => {
  function harness(failFor = new Set<string>()) {
    const made: Array<{ path: string; w: Watcher & { close: ReturnType<typeof vi.fn> }; onError: () => void }> = [];
    const onLost = vi.fn();
    const pool = createWatcherPool((p, _onChange, onError) => {
      if (failFor.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const w = { close: vi.fn() };
      made.push({ path: p, w, onError: () => onError(new Error('gone')) });
      return w;
    }, onLost);
    return { pool, made, onLost };
  }

  it('命中的路径各新建一个、关闭旧的;引用计数不变(一次 unwatch 关不掉两次 watch 的);未命中的不动', () => {
    const { pool, made } = harness();
    const cb = vi.fn();
    pool.watch('/mnt/vol', cb, 1);
    pool.watch('/mnt/vol', cb, 2);
    pool.watch('/mnt/vol/src', cb, 1);
    pool.watch('/other', cb, 1);
    pool.recreate((p) => p === '/mnt/vol' || p.startsWith('/mnt/vol/'));
    expect(made.map((x) => x.path)).toEqual(['/mnt/vol', '/mnt/vol/src', '/other', '/mnt/vol', '/mnt/vol/src']);
    expect(made[0]!.w.close).toHaveBeenCalledTimes(1);
    expect(made[1]!.w.close).toHaveBeenCalledTimes(1);
    expect(made[2]!.w.close).not.toHaveBeenCalled();
    pool.unwatch('/mnt/vol', 1);
    expect(made[3]!.w.close).not.toHaveBeenCalled();
    pool.unwatch('/mnt/vol', 2);
    expect(made[3]!.w.close).toHaveBeenCalledTimes(1);
  });

  it('旧 watcher 迟到的 error 不驱逐新 watcher;新 watcher 的 error 照常驱逐', () => {
    const { pool, made, onLost } = harness();
    pool.watch('/mnt/vol', vi.fn(), 1);
    pool.recreate(() => true);
    made[0]!.onError();
    expect(pool.has('/mnt/vol')).toBe(true);
    expect(onLost).not.toHaveBeenCalled();
    made[1]!.onError();
    expect(pool.has('/mnt/vol')).toBe(false);
    expect(onLost).toHaveBeenCalledWith('/mnt/vol', [1]);
  });

  it('重建失败(目录此刻不在)→ 按失效驱逐,通知持有者重装', () => {
    const fail = new Set<string>();
    const { pool, made, onLost } = harness(fail);
    pool.watch('/mnt/vol/src', vi.fn(), 3);
    fail.add('/mnt/vol/src');
    pool.recreate(() => true);
    expect(pool.has('/mnt/vol/src')).toBe(false);
    expect(made[0]!.w.close).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith('/mnt/vol/src', [3]);
  });
});

describe('生产接线(fs.ipc):根被换成同路径的另一个目录', () => {
  afterEach(() => {
    m.handlers.clear();
    m.sends = [];
    m.watched = [];
  });

  it('设定工作区根时记基线;窗口获焦时发现 dev / ino 变了 → 广播根存在性变化,并重建根下 watcher', async () => {
    const { checkWindowRootPresence, registerFsIpc, releaseFsWatchersForWindow } = await import(
      '../../../electron/main/ipc/fs.ipc'
    );
    const { setWorkspaceRoot } = await import('../../../electron/main/services/window-workspace-roots.service');
    const base = await mkdtemp(path.join(tmpdir(), 'continuo-root-id-'));
    const root = path.join(base, 'mnt');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'a.txt'), 'a');
    setWorkspaceRoot(7, root);
    registerFsIpc();
    const event = { sender: Object.assign(new EventEmitter(), { id: 70 }), senderFrame: { url: 'file:///app/index.html' } };
    try {
      for (const p of [root, path.join(root, 'src')]) {
        const r = (await m.handlers.get(FS_CHANNELS.WATCH)!(event, { path: p })) as { ok: boolean };
        expect(r.ok).toBe(true);
      }
      await settle();
      checkWindowRootPresence(7);
      await settle();
      const presence = () => m.sends.filter(([ch]) => ch === FS_CHANNELS.ROOT_PRESENCE_CHANGED);
      expect(presence()).toEqual([]);

      // 「卸载」:原目录挪走,同一路径换成一个新的空目录(固定挂载点露出来)
      await rename(root, path.join(base, 'old'));
      await mkdir(root);
      const before = m.watched.length;
      checkWindowRootPresence(7);
      await settle();
      expect(presence()).toEqual([[FS_CHANNELS.ROOT_PRESENCE_CHANGED, { path: root }]]);
      expect(m.watched.slice(before).map((w) => w.path).sort()).toEqual([root, path.join(root, 'src')].sort());
      expect(m.watched.slice(0, before).every((w) => w.close.mock.calls.length === 1)).toBe(true);
    } finally {
      releaseFsWatchersForWindow(7);
      setWorkspaceRoot(7, null);
      await rm(base, { recursive: true, force: true });
    }
  });
});
