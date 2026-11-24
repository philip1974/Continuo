// 资源泄漏:fs watcher 的窗口归属引用(ownerPaths / refCount)此前只在窗口 closed 时经
// releaseFsWatchersForWindow 释放。renderer reload(webContents 与 BrowserWindow 都不变)时旧文档
// 不会 unwatch,新文档又对已展开目录重新 watch → refCount+1,旧引用永不释放:之后折叠也关不掉
// fs.watch,持续广播并占 LRU 名额。
// 契约:sender 主框架非同文档导航(reload)即按 BrowserWindow id 释放该窗口全部 watch 引用(与关窗同一
// 路径);同文档导航不释放;其它窗口对同一路径的引用不受影响。

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FS_CHANNELS } from '../../../electron/shared/fs-channels';

const m = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  senderToWindow: new Map<object, { id: number }>(),
  closes: new Map<string, Array<ReturnType<typeof vi.fn>>>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, h: (event: unknown, raw: unknown) => Promise<unknown>) =>
      m.handlers.set(channel, h),
  },
  BrowserWindow: {
    fromWebContents: (sender: object) => m.senderToWindow.get(sender) ?? null,
    getAllWindows: () => [],
    fromId: () => null,
  },
  dialog: {},
  shell: {},
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const watch = vi.fn((p: string) => {
    const close = vi.fn();
    const list = m.closes.get(p) ?? [];
    list.push(close);
    m.closes.set(p, list);
    return Object.assign(new EventEmitter(), { close });
  });
  return { ...actual, default: { ...actual, watch }, watch };
});

import { registerFsIpc, releaseFsWatchersForWindow } from '../../../electron/main/ipc/fs.ipc';

let nextWcId = 100;
function makeSender(windowId: number) {
  const emitter = new EventEmitter();
  const sender = Object.assign(emitter, { id: nextWcId++ });
  m.senderToWindow.set(sender, { id: windowId });
  return {
    event: { sender, senderFrame: { url: 'file:///app/index.html' } },
    reload: () =>
      emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }),
    hashNav: () =>
      emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }),
  };
}

async function call(
  channel: string,
  event: unknown,
  path: string,
): Promise<void> {
  const r = (await m.handlers.get(channel)!(event, { path })) as { ok: boolean };
  expect(r.ok).toBe(true);
}

const closeOf = (p: string) => m.closes.get(p)!.at(-1)!;

beforeEach(() => {
  m.handlers.clear();
  registerFsIpc();
});
afterEach(() => {
  // 清掉本用例遗留的模块级 pool 引用
  releaseFsWatchersForWindow(1);
  releaseFsWatchersForWindow(2);
  m.closes.clear();
  m.senderToWindow.clear();
});

describe('fs:watch · renderer reload 释放该窗口的 watcher 引用', () => {
  it('reload 后新文档重新 watch 同目录,折叠(一次 unwatch)即关闭 fs.watch', async () => {
    const win = makeSender(1);
    await call(FS_CHANNELS.WATCH, win.event, '/proj/src');

    win.reload();
    // 新文档重新 watch(旧文档从未 unwatch)
    await call(FS_CHANNELS.WATCH, win.event, '/proj/src');
    await call(FS_CHANNELS.UNWATCH, win.event, '/proj/src');

    expect(m.closes.get('/proj/src')!.every((c) => c.mock.calls.length === 1)).toBe(true);
  });

  it('同文档导航(hash / pushState)不释放', async () => {
    const win = makeSender(1);
    await call(FS_CHANNELS.WATCH, win.event, '/proj/a');
    win.hashNav();
    expect(closeOf('/proj/a')).not.toHaveBeenCalled();
  });

  it('一个窗口 reload 不影响其它窗口对同一路径的引用', async () => {
    const a = makeSender(1);
    const b = makeSender(2);
    await call(FS_CHANNELS.WATCH, a.event, '/proj/shared');
    await call(FS_CHANNELS.WATCH, b.event, '/proj/shared');

    a.reload();
    expect(closeOf('/proj/shared')).not.toHaveBeenCalled();

    await call(FS_CHANNELS.UNWATCH, b.event, '/proj/shared');
    expect(closeOf('/proj/shared')).toHaveBeenCalledTimes(1);
  });
});

// 取不到 sender 窗口(窗口销毁过程中到达)→ NO_WINDOW,不建 watcher:此前降级为无 owner 的 watch,既不进 owner 记账也
// 不挂 wc-gone 钩子,窗口释放时回收不到,引用常驻(与 terminal / debug-view 的 safeHandleWithWindow 同口径)。
describe('fs:watch · 无所属窗口', () => {
  it('sender 不属于任何窗口 → NO_WINDOW,不创建 fs.watch', async () => {
    const orphan = Object.assign(new EventEmitter(), { id: nextWcId++ });
    const r = (await m.handlers.get(FS_CHANNELS.WATCH)!(
      { sender: orphan, senderFrame: { url: 'file:///app/index.html' } },
      { path: '/orphan' },
    )) as { ok: boolean; code?: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_WINDOW');
    expect(m.closes.get('/orphan')).toBeUndefined();
  });
});

