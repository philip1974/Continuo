// 跨窗口卸载:main 侧在卸载成功后向所有窗口广播 plugins:uninstalled(终审 P1)。见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, raw: unknown) => Promise<unknown>;
type MockWin = { isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } };

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  windows: [] as unknown[],
  uninstallPlugin: { current: null as null | ((...args: unknown[]) => Promise<void>) },
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/continuo-test-user-data' },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => h.windows },
}));

vi.mock('../../../electron/main/services/plugins.service', () => ({
  createPluginsWatcher: () => ({ start: () => {}, stop: () => {} }),
  installFromGit: async () => undefined,
  listPluginDirs: async () => [],
  recoverInterruptedInstalls: async () => undefined,
  readEnabledIds: async () => [],
  readPermissions: async () => ({}),
  setEnabledId: async () => undefined,
  uninstallPlugin: (...args: unknown[]) => h.uninstallPlugin.current!(...args),
  writePluginPermissions: async () => undefined,
}));

import { registerPluginsIpc } from '../../../electron/main/ipc/plugins.ipc';
import { PLUGINS_CHANNELS } from '../../../electron/shared/plugins-channels';

const RENDERER_URL = 'http://localhost:5173';
const TRUSTED = { senderFrame: { url: `${RENDERER_URL}/` } };

function makeWin(destroyed = false): MockWin {
  return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } };
}

function uninstall(id: string): Promise<unknown> {
  const fn = h.handlers.get(PLUGINS_CHANNELS.UNINSTALL);
  if (!fn) throw new Error('missing uninstall handler');
  return fn(TRUSTED, { id });
}

function uninstalledSends(win: MockWin): unknown[] {
  return win.webContents.send.mock.calls
    .filter((c) => c[0] === PLUGINS_CHANNELS.UNINSTALLED)
    .map((c) => c[1]);
}

const savedEnv = process.env['ELECTRON_RENDERER_URL'];
let uninstallImpl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env['ELECTRON_RENDERER_URL'] = RENDERER_URL;
  h.handlers.clear();
  h.windows.length = 0;
  uninstallImpl = vi.fn().mockResolvedValue(undefined);
  h.uninstallPlugin.current = uninstallImpl as unknown as (...args: unknown[]) => Promise<void>;
  registerPluginsIpc();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env['ELECTRON_RENDERER_URL'];
  else process.env['ELECTRON_RENDERER_URL'] = savedEnv;
});

describe('main:卸载成功后广播 plugins:uninstalled', () => {
  it('向所有存活窗口(含发起卸载的窗口)广播 { id };跳过已销毁窗口', async () => {
    const a = makeWin();
    const b = makeWin();
    const dead = makeWin(true);
    h.windows.push(a, dead, b);

    await expect(uninstall('com.x.p')).resolves.toMatchObject({ ok: true });

    expect(uninstallImpl).toHaveBeenCalledWith(expect.any(String), 'com.x.p');
    expect(uninstalledSends(a)).toEqual([{ id: 'com.x.p' }]);
    expect(uninstalledSends(b)).toEqual([{ id: 'com.x.p' }]);
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });

  it('某窗口 send 抛错 → 不影响其它窗口,也不影响卸载结果', async () => {
    const broken = makeWin();
    broken.webContents.send.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    const ok = makeWin();
    h.windows.push(broken, ok);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(uninstall('com.x.p')).resolves.toMatchObject({ ok: true });
    expect(uninstalledSends(ok)).toEqual([{ id: 'com.x.p' }]);
    err.mockRestore();
  });

  it('卸载失败 → 不广播(其它窗口的插件照常运行)', async () => {
    const a = makeWin();
    h.windows.push(a);
    uninstallImpl.mockRejectedValueOnce(Object.assign(new Error('rm failed'), { code: 'RM_FAILED' }));

    await expect(uninstall('com.x.p')).resolves.toMatchObject({ ok: false });
    expect(uninstalledSends(a)).toEqual([]);
  });
});
