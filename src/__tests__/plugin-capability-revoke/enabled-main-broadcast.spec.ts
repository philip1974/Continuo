// 跨窗口启用状态:main 在 _enabled.json 写入成功后广播 plugins:enabled-changed { id, enabled }(终审 P1)。
// 见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, raw: unknown) => Promise<unknown>;
type MockWin = { isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } };

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  windows: [] as unknown[],
  setEnabledId: { current: null as null | ((...args: unknown[]) => Promise<void>) },
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
  setEnabledId: (...args: unknown[]) => h.setEnabledId.current!(...args),
  uninstallPlugin: async () => undefined,
  mutatePluginPermissions: async () => null,
}));

import { registerPluginsIpc } from '../../../electron/main/ipc/plugins.ipc';
import {
  PLUGINS_CHANNELS,
  isPluginEnabledChangedPayload,
} from '../../../electron/shared/plugins-channels';

import { setTrustedDevOrigin } from '../../../electron/main/safe-handle';
import { makeFakeWin } from '../_helpers/fake-window';

const RENDERER_URL = 'http://localhost:5173';
const TRUSTED = { senderFrame: { url: `${RENDERER_URL}/` } };

function mutate(id: string, enabled: boolean): Promise<unknown> {
  const fn = h.handlers.get(PLUGINS_CHANNELS.MUTATE_ENABLED);
  if (!fn) throw new Error('missing mutate-enabled handler');
  return fn(TRUSTED, { id, enabled });
}

function sends(win: MockWin): unknown[] {
  return win.webContents.send.mock.calls
    .filter((c) => c[0] === PLUGINS_CHANNELS.ENABLED_CHANGED)
    .map((c) => c[1]);
}

let setImpl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setTrustedDevOrigin(RENDERER_URL);
  h.handlers.clear();
  h.windows.length = 0;
  setImpl = vi.fn().mockResolvedValue(undefined);
  h.setEnabledId.current = setImpl as unknown as (...args: unknown[]) => Promise<void>;
  registerPluginsIpc();
});

afterEach(() => {
  setTrustedDevOrigin(null);
});

describe('main:启用状态写入成功后广播 plugins:enabled-changed', () => {
  it('禁用 / 启用成功 → 向所有存活窗口(含发起者)广播 { id, enabled };跳过已销毁窗口', async () => {
    const a = makeFakeWin();
    const b = makeFakeWin();
    const dead = makeFakeWin({ destroyed: true });
    h.windows.push(a, dead, b);

    await expect(mutate('com.x.p', false)).resolves.toMatchObject({ ok: true });
    await expect(mutate('com.x.p', true)).resolves.toMatchObject({ ok: true });

    expect(setImpl).toHaveBeenCalledWith(expect.any(String), 'com.x.p', false);
    const expected = [
      { id: 'com.x.p', enabled: false },
      { id: 'com.x.p', enabled: true },
    ];
    expect(sends(a)).toEqual(expected);
    expect(sends(b)).toEqual(expected);
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });

  it('写入失败 → 不广播', async () => {
    const a = makeFakeWin();
    h.windows.push(a);
    setImpl.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(mutate('com.x.p', false)).resolves.toMatchObject({ ok: false });
    expect(sends(a)).toEqual([]);
  });
});

describe('payload 守卫 isPluginEnabledChangedPayload', () => {
  it('合法:非空 id + boolean enabled', () => {
    expect(isPluginEnabledChangedPayload({ id: 'a.b', enabled: false })).toBe(true);
    expect(isPluginEnabledChangedPayload({ id: 'a.b', enabled: true })).toBe(true);
  });

  it('畸形:null / 缺 enabled / 非 boolean / 空或超长 id', () => {
    expect(isPluginEnabledChangedPayload(null)).toBe(false);
    expect(isPluginEnabledChangedPayload({ id: 'a.b' })).toBe(false);
    expect(isPluginEnabledChangedPayload({ id: 'a.b', enabled: 'false' })).toBe(false);
    expect(isPluginEnabledChangedPayload({ id: '', enabled: true })).toBe(false);
    expect(isPluginEnabledChangedPayload({ id: 'x'.repeat(100_000), enabled: true })).toBe(false);
  });
});
