// race(R67-A,R63/R64/R65/R66 同族):plugins.ipc 的 broadcastPluginsChanged(createPluginsWatcher
// 的 onChange)遍历窗口裸 win.webContents.send。窗口在 isDestroyed() 检查后销毁 → send 抛
// "Object has been destroyed":(1)中断循环使后续窗口漏收热重载通知;(2)抛回 watcher 扫描循环被
// per-entry catch 吞掉 → mtimes 不推进(R67-B)→ 同一变更反复触发。修复:每个窗口 send 独立 try/catch。

import { afterEach, describe, expect, it, vi } from 'vitest';

type FakeWin = {
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
};

const mocks = vi.hoisted(() => ({ windows: [] as FakeWin[] }));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mocks.windows },
  app: { getPath: () => '/tmp/continuo-test-userdata' },
}));

function makeWin(opts: { throwOnSend?: boolean } = {}): FakeWin {
  const send = vi.fn(() => {
    if (opts.throwOnSend) throw new Error('Object has been destroyed');
  });
  return { isDestroyed: () => false, webContents: { send } };
}

afterEach(() => {
  mocks.windows = [];
  vi.clearAllMocks();
});

describe('race(R67-A) · plugins broadcastPluginsChanged 单窗口 send 抛错不中断', () => {
  it('第一个窗口 send 抛错 → 不抛 + 其后窗口仍收到 PLUGINS_CHANGED', async () => {
    const dead = makeWin({ throwOnSend: true });
    const healthy = makeWin();
    mocks.windows = [dead, healthy];
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { broadcastPluginsChanged } = await import(
      '../../../electron/main/ipc/plugins.ipc'
    );
    const { PLUGINS_CHANNELS } = await import(
      '../../../electron/shared/plugins-channels'
    );

    // onChange 由 watcher 在 fs 扫描循环里调用;裸抛会被 per-entry catch 吞掉致 mtime 不推进。
    // 断言不抛(扫描循环安全)+ 抛错窗口之后的健康窗口仍收到广播。
    expect(() => broadcastPluginsChanged('p1')).not.toThrow();
    expect(healthy.webContents.send).toHaveBeenCalledWith(
      PLUGINS_CHANNELS.CHANGED,
      { id: 'p1' },
    );
  });
});
