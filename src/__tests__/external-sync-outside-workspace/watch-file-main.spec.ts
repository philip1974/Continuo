// main 侧 fs:watch-file(工作区外可见文件的父目录 watcher):只接受本窗口经 fs:read-file 读过的文件;对父目录装**非递归**
// watcher,同目录按引用计数共享;变化经 fs:dir-changed 广播(带文件名);unwatch / 关窗 / reload 释放;数量有上限(超出拒绝)。
// 对齐 VSCode editorService.handleVisibleEditorsChange(可见的工作区外资源单独 fileService.watch)。

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FS_CHANNELS } from '../../../electron/shared/fs-channels';

const m = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  senderToWindow: new Map<object, { id: number }>(),
  watchers: [] as Array<{
    path: string;
    opts: { recursive?: boolean };
    cb: (eventType: string, filename: string | null) => void;
    close: ReturnType<typeof vi.fn>;
  }>,
  sent: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, h: (event: unknown, raw: unknown) => Promise<unknown>) => m.handlers.set(channel, h),
  },
  BrowserWindow: {
    fromWebContents: (sender: object) => m.senderToWindow.get(sender) ?? null,
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => m.sent.push({ channel, payload }),
        },
      },
    ],
    fromId: () => null,
  },
  dialog: {},
  shell: {},
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const watch = vi.fn(
    (p: string, opts: { recursive?: boolean }, cb: (eventType: string, filename: string | null) => void) => {
      const close = vi.fn();
      m.watchers.push({ path: p, opts, cb, close });
      return Object.assign(new EventEmitter(), { close });
    },
  );
  return { ...actual, default: { ...actual, watch }, watch };
});

// fs:read-file 的读取本身不是这里的关注点:桩成固定文本(登记「本窗口读过」走真实 recordingReadFileHandler)。
vi.mock('../../../electron/main/ipc/fs/read-file', () => ({
  readFile: vi.fn(async () => ({ content: 'log\n', encoding: 'utf8' })),
}));
vi.mock('../../../electron/main/ipc/fs/atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/main/ipc/fs/atomic-write')>();
  return { ...actual, resolveSymlinkTarget: async (p: string) => p };
});

import { MAX_FILE_WATCHERS, registerFsIpc, releaseFsWatchersForWindow } from '../../../electron/main/ipc/fs.ipc';
import { _reset as resetEditorDocuments } from '../../../electron/main/services/window-editor-documents.service';

let nextWcId = 500;
function makeSender(windowId: number) {
  const emitter = new EventEmitter();
  const sender = Object.assign(emitter, { id: nextWcId++ });
  m.senderToWindow.set(sender, { id: windowId });
  return {
    event: { sender, senderFrame: { url: 'file:///app/index.html' } },
    reload: () => emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }),
  };
}

type Result = { ok: boolean; code?: string };
const invoke = async (channel: string, event: unknown, payload: unknown): Promise<Result> =>
  (await m.handlers.get(channel)!(event, payload)) as Result;

async function open(event: unknown, path: string): Promise<void> {
  expect((await invoke(FS_CHANNELS.READ_FILE, event, { path })).ok).toBe(true);
}

const watchersOf = (p: string) => m.watchers.filter((w) => w.path === p);
const flushImmediate = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  m.handlers.clear();
  registerFsIpc();
});
afterEach(() => {
  releaseFsWatchersForWindow(1);
  releaseFsWatchersForWindow(2);
  resetEditorDocuments();
  m.watchers.length = 0;
  m.sent.length = 0;
  m.senderToWindow.clear();
});

describe('fs:watch-file · 工作区外已打开文件的父目录 watcher', () => {
  it('本窗口读过的文件 → 对父目录装非递归 watcher;目录内变化经 fs:dir-changed 广播(带文件名)', async () => {
    const win = makeSender(1);
    await open(win.event, '/var/log/app.log');
    expect((await invoke(FS_CHANNELS.WATCH_FILE, win.event, { path: '/var/log/app.log' })).ok).toBe(true);

    const [w] = watchersOf('/var/log');
    expect(w).toBeDefined();
    expect(w!.opts.recursive).toBe(false);

    w!.cb('change', 'app.log');
    await flushImmediate();
    expect(m.sent).toContainEqual({
      channel: FS_CHANNELS.DIR_CHANGED,
      payload: { path: '/var/log', files: ['app.log'], changeOnly: true },
    });
  });

  it('本窗口没读过的文件、不规范路径(含 ..)→ 拒绝,不装 watcher', async () => {
    const a = makeSender(1);
    const b = makeSender(2);
    await open(b.event, '/etc/hosts');
    expect(await invoke(FS_CHANNELS.WATCH_FILE, a.event, { path: '/etc/hosts' })).toMatchObject({ ok: false, code: 'FS_DENIED' });
    await open(a.event, '/tmp/x/../y.log');
    expect(await invoke(FS_CHANNELS.WATCH_FILE, a.event, { path: '/tmp/x/../y.log' })).toMatchObject({ ok: false, code: 'FS_DENIED' });
    expect(m.watchers).toHaveLength(0);
  });

  it('同目录两个文件共用一个 watcher,两个都 unwatch 才关闭', async () => {
    const win = makeSender(1);
    await open(win.event, '/logs/a.log');
    await open(win.event, '/logs/b.log');
    await invoke(FS_CHANNELS.WATCH_FILE, win.event, { path: '/logs/a.log' });
    await invoke(FS_CHANNELS.WATCH_FILE, win.event, { path: '/logs/b.log' });
    expect(watchersOf('/logs')).toHaveLength(1);
    const { close } = watchersOf('/logs')[0]!;

    await invoke(FS_CHANNELS.UNWATCH_FILE, win.event, { path: '/logs/a.log' });
    expect(close).not.toHaveBeenCalled();
    await invoke(FS_CHANNELS.UNWATCH_FILE, win.event, { path: '/logs/b.log' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('关窗 / renderer reload 释放该窗口的全部 file watcher', async () => {
    const win = makeSender(1);
    await open(win.event, '/o1/a.log');
    await open(win.event, '/o2/b.log');
    await invoke(FS_CHANNELS.WATCH_FILE, win.event, { path: '/o1/a.log' });
    await invoke(FS_CHANNELS.WATCH_FILE, win.event, { path: '/o2/b.log' });
    win.reload();
    expect(watchersOf('/o1')[0]!.close).toHaveBeenCalledTimes(1);

    const other = makeSender(2);
    await open(other.event, '/o3/c.log');
    await invoke(FS_CHANNELS.WATCH_FILE, other.event, { path: '/o3/c.log' });
    releaseFsWatchersForWindow(2);
    expect(watchersOf('/o3')[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('数量上限 MAX_FILE_WATCHERS:超出拒绝,已装的不被驱逐;已有目录仍可加引用', async () => {
    const win = makeSender(1);
    for (let i = 0; i < MAX_FILE_WATCHERS; i++) {
      await open(win.event, `/d${i}/f.log`);
      expect((await invoke(FS_CHANNELS.WATCH_FILE, win.event, { path: `/d${i}/f.log` })).ok).toBe(true);
    }
    await open(win.event, '/over/f.log');
    expect(await invoke(FS_CHANNELS.WATCH_FILE, win.event, { path: '/over/f.log' })).toMatchObject({ ok: false });
    expect(watchersOf('/over')).toHaveLength(0);
    expect(m.watchers.every((w) => w.close.mock.calls.length === 0)).toBe(true);

    await open(win.event, '/d0/g.log');
    expect((await invoke(FS_CHANNELS.WATCH_FILE, win.event, { path: '/d0/g.log' })).ok).toBe(true);
  });
});
