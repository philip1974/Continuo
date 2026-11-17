// race(R66,R63/R64/R65 同族):fs.ipc broadcastDirChanged 由 fs.watch 回调触发,遍历窗口
// 裸 w.webContents.send(DIR_CHANGED)。窗口在 isDestroyed() 检查后、send 前销毁 → send 抛
// "Object has been destroyed":(1)中断循环使后续窗口漏收 DIR_CHANGED,Explorer/外部同步停旧树;
// (2)在 fs.watch 异步事件回调里成主进程未捕获异常。修复:每个窗口 send 独立 try/catch。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type FakeWin = {
  isDestroyed: () => boolean;
  webContents: {
    isDestroyed: () => boolean;
    send: ReturnType<typeof vi.fn>;
  };
};

const mocks = vi.hoisted(() => ({
  windows: [] as FakeWin[],
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mocks.windows },
  dialog: {},
  shell: {},
}));

function makeWin(opts: { throwOnSend?: boolean } = {}): FakeWin {
  const send = vi.fn(() => {
    if (opts.throwOnSend) throw new Error('Object has been destroyed');
  });
  return { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } };
}

afterEach(() => {
  mocks.windows = [];
  vi.clearAllMocks();
});

describe('race(R66) · fs broadcastDirChanged 单窗口 send 抛错不中断广播', () => {
  it('第一个窗口 send 抛错 → 不抛 + 其后窗口仍收到 DIR_CHANGED', async () => {
    const dead = makeWin({ throwOnSend: true });
    const healthy = makeWin();
    mocks.windows = [dead, healthy];
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { broadcastDirChanged } = await import(
      '../../../electron/main/ipc/fs.ipc'
    );
    const { FS_CHANNELS } = await import('../../../electron/shared/fs-channels');

    // fs.watch 回调里裸抛会冒泡成主进程未捕获异常;断言不抛(回调安全)。
    expect(() => broadcastDirChanged('/some/dir')).not.toThrow();

    // 抛错窗口之后的健康窗口仍收到广播(循环未中断)。
    expect(healthy.webContents.send).toHaveBeenCalledWith(FS_CHANNELS.DIR_CHANGED, {
      path: '/some/dir',
    });
  });
});

// 性能(审计 #1):生产 watch 回调经 queueDirChangedBroadcast 入队,同 tick 内多个 recursive 祖先
// watcher 报告的同一 changedPath 只向每个窗口发一次 DIR_CHANGED。
describe('perf · queueDirChangedBroadcast 同 tick 同路径合并广播', () => {
  it('同 tick 重复路径 → 每窗口每路径只 send 一次', async () => {
    const w = makeWin();
    mocks.windows = [w];
    const { queueDirChangedBroadcast } = await import('../../../electron/main/ipc/fs.ipc');
    const { FS_CHANNELS } = await import('../../../electron/shared/fs-channels');

    queueDirChangedBroadcast('/r/a/b');
    queueDirChangedBroadcast('/r/a/b');
    queueDirChangedBroadcast('/r/a/b');
    queueDirChangedBroadcast('/r/c');
    await new Promise((r) => setImmediate(r));

    expect(w.webContents.send.mock.calls).toEqual([
      [FS_CHANNELS.DIR_CHANGED, { path: '/r/a/b' }],
      [FS_CHANNELS.DIR_CHANGED, { path: '/r/c' }],
    ]);
  });

  it('同 tick 带文件名 → payload 携带去重后的 files;缺 filename 的目录不带 files 字段', async () => {
    const w = makeWin();
    mocks.windows = [w];
    const { queueDirChangedBroadcast } = await import('../../../electron/main/ipc/fs.ipc');
    const { FS_CHANNELS } = await import('../../../electron/shared/fs-channels');

    queueDirChangedBroadcast('/r/a', 'x.md');
    queueDirChangedBroadcast('/r/a', 'x.md');
    queueDirChangedBroadcast('/r/b', 'y.md');
    queueDirChangedBroadcast('/r/b');
    await new Promise((r) => setImmediate(r));

    expect(w.webContents.send.mock.calls).toEqual([
      [FS_CHANNELS.DIR_CHANGED, { path: '/r/a', files: ['x.md'] }],
      [FS_CHANNELS.DIR_CHANGED, { path: '/r/b' }],
    ]);
  });

  it('WATCH handler 的 watcher 回调走 queueDirChangedBroadcast(非逐次直接广播)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', 'electron', 'main', 'ipc', 'fs.ipc.ts'),
      'utf-8',
    );
    const call = src.slice(src.indexOf('watcherPool.watch('), src.indexOf('ownerId,', src.indexOf('watcherPool.watch(')));
    expect(call).toContain('queueDirChangedBroadcast');
    expect(call).not.toContain('broadcastDirChanged');
  });
});
