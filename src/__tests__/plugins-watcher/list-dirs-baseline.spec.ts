// 冷启动性能:registerPluginsIpc(早于建首窗)不再立即首扫插件目录;基线改由 LIST_DIRS 在列举前按需建立,
// 保证「renderer 列举之后的插件修改」一定被下一轮 tick 广播(无漏报窗口)。
import { mkdtempSync, mkdirSync, promises as fsp, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, (input: unknown) => Promise<unknown>>(),
  broadcast: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

vi.mock('../../../electron/main/safe-handle', () => ({
  defaultIsTrustedFrame: () => true,
  safeHandle: (channel: string, _schema: unknown, fn: (input: unknown) => Promise<unknown>) => {
    h.handlers.set(channel, fn);
  },
  safeHandleWithCtx: (channel: string, _schema: unknown, fn: (input: unknown) => Promise<unknown>) => {
    h.handlers.set(channel, fn);
  },
}));

vi.mock('../../../electron/main/lib/broadcast', () => ({
  broadcastToWindows: (channel: string, payload: () => unknown) => h.broadcast(channel, payload()),
}));

import { PLUGINS_CHANNELS } from '../../../electron/shared/plugins-channels';

h.userData = mkdtempSync(join(tmpdir(), 'lm-list-baseline-'));
const pluginDir = join(h.userData, 'plugins', 'a');

afterAll(() => {
  vi.useRealTimers();
  rmSync(h.userData, { recursive: true, force: true });
});

describe('LIST_DIRS 列举前建立 watcher 基线', () => {
  it('启动不立即首扫;LIST_DIRS 先建基线 → 列举后修改插件,下一轮 tick 广播 CHANGED', async () => {
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({ id: 'a', name: 'A', version: '0.1.0' }));
    writeFileSync(join(pluginDir, 'main.js'), '/* main */');

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { registerPluginsIpc } = await import('../../../electron/main/ipc/plugins.ipc');
    const realStat = fsp.stat.bind(fsp);
    let mainStats = 0;
    vi.spyOn(fsp, 'stat').mockImplementation(((p: string, ...rest: unknown[]) => {
      if (String(p) === join(pluginDir, 'main.js')) mainStats += 1;
      return (realStat as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as typeof fsp.stat);
    registerPluginsIpc();
    // 注册后(建窗前)不立即扫描插件目录
    await new Promise((r) => setTimeout(r, 50));
    expect(mainStats).toBe(0);

    const listed = (await h.handlers.get(PLUGINS_CHANNELS.LIST_DIRS)!(undefined)) as unknown[];
    expect(listed).toHaveLength(1);

    // 列举之后修改插件 main → 下一轮周期 tick 必须广播(基线已在列举前建立,而非把这次修改吞成基线)
    const t = (Date.now() + 5000) / 1000;
    utimesSync(join(pluginDir, 'main.js'), t, t);
    vi.advanceTimersByTime(2000);
    await vi.waitFor(() =>
      expect(h.broadcast).toHaveBeenCalledWith(PLUGINS_CHANNELS.CHANGED, { id: 'a' }),
    );
  });
});
