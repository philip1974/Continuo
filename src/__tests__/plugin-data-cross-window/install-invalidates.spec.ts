// 安装 / 更新插件成功后向所有窗口(含发起者)广播 plugin-data:changed:更新可能改写盘上 data.json(旧目录无 data.json 时
// 新版仓库自带的那份原样落地),各窗口的数据缓存须失效,否则新版 loadData() 读到旧缓存、首次 saveData 覆盖仓库那份。
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, raw: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  windows: [] as unknown[],
  install: { current: null as null | (() => Promise<unknown>) },
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/continuo-test-user-data', getVersion: () => '0.2.15' },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => h.windows },
}));

vi.mock('../../../electron/main/services/plugins.service', () => ({
  createPluginsWatcher: () => ({ start: () => {}, stop: () => {} }),
  installFromGit: () => h.install.current!(),
  listPluginDirs: async () => [],
  recoverInterruptedInstalls: async () => undefined,
  readEnabledIds: async () => [],
  readPermissions: async () => ({}),
  setEnabledId: async () => undefined,
  uninstallPlugin: async () => undefined,
  mutatePluginPermissions: async () => null,
}));

import { registerPluginsIpc } from '../../../electron/main/ipc/plugins.ipc';
import { PLUGINS_CHANNELS } from '../../../electron/shared/plugins-channels';
import { PLUGIN_DATA_CHANNELS } from '../../../electron/shared/plugin-data-channels';
import { setTrustedDevOrigin } from '../../../electron/main/safe-handle';
import { makeFakeWin, type FakeWin } from '../_helpers/fake-window';

const RENDERER_URL = 'http://localhost:5173';

function install(): Promise<unknown> {
  return h.handlers.get(PLUGINS_CHANNELS.INSTALL_FROM_GIT)!(
    { senderFrame: { url: `${RENDERER_URL}/` } },
    { url: 'https://github.com/me/p.git', overwrite: true },
  );
}

function changed(win: FakeWin): unknown[] {
  return win.webContents.send.mock.calls.filter((c) => c[0] === PLUGIN_DATA_CHANNELS.CHANGED).map((c) => c[1]);
}

beforeEach(() => {
  setTrustedDevOrigin(RENDERER_URL);
  h.handlers.clear();
  h.windows.length = 0;
  registerPluginsIpc();
});

describe('安装 / 更新后插件数据缓存失效广播', () => {
  it('成功 → 向所有窗口广播 { id };失败 → 不广播', async () => {
    const a = makeFakeWin();
    const b = makeFakeWin();
    h.windows.push(a, b);
    h.install.current = async () => ({ id: 'com.x.p', name: 'P', version: '2.0.0' });
    await expect(install()).resolves.toMatchObject({ ok: true });
    expect(changed(a)).toEqual([{ id: 'com.x.p' }]);
    expect(changed(b)).toEqual([{ id: 'com.x.p' }]);

    h.install.current = async () => {
      throw Object.assign(new Error('nope'), { code: 'CLONE_FAILED' });
    };
    await install();
    expect(changed(a)).toHaveLength(1);
  });
});
