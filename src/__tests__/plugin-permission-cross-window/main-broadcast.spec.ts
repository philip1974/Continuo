// 插件授权变更 IPC:成功后向所有窗口广播 plugins:permissions-changed(终审 P1)。见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, raw: unknown) => Promise<unknown>;
type MockWin = { isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } };

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  windows: [] as unknown[],
  mutate: { current: null as null | ((...args: unknown[]) => Promise<unknown>) },
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
  uninstallPlugin: async () => undefined,
  mutatePluginPermissions: (...args: unknown[]) => h.mutate.current!(...args),
}));

import {
  MutatePluginPermissionsInput,
  registerPluginsIpc,
} from '../../../electron/main/ipc/plugins.ipc';
import { PLUGINS_CHANNELS } from '../../../electron/shared/plugins-channels';

import { setTrustedDevOrigin } from '../../../electron/main/safe-handle';
import { makeFakeWin } from '../_helpers/fake-window';

const RENDERER_URL = 'http://localhost:5173';
const TRUSTED = { senderFrame: { url: `${RENDERER_URL}/` } };
const ID = 'com.x.p';

function mutate(raw: unknown, event: unknown = TRUSTED): Promise<unknown> {
  const fn = h.handlers.get(PLUGINS_CHANNELS.MUTATE_PLUGIN_PERMISSIONS);
  if (!fn) throw new Error('missing mutate handler');
  return fn(event, raw);
}

function changedSends(win: MockWin): unknown[] {
  return win.webContents.send.mock.calls
    .filter((c) => c[0] === PLUGINS_CHANNELS.PERMISSIONS_CHANGED)
    .map((c) => c[1]);
}

let mutateImpl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setTrustedDevOrigin(RENDERER_URL);
  h.handlers.clear();
  h.windows.length = 0;
  mutateImpl = vi.fn();
  h.mutate.current = mutateImpl as unknown as (...args: unknown[]) => Promise<unknown>;
  registerPluginsIpc();
});

afterEach(() => {
  setTrustedDevOrigin(null);
});

describe('main:plugins:mutate-plugin-permissions', () => {
  it('不再提供整条记录覆盖写通道', () => {
    expect(h.handlers.has('plugins:write-plugin-permissions')).toBe(false);
  });

  it('成功 → 返回合并记录,并向所有窗口(含发起者)广播 { id }', async () => {
    const merged = [{ permission: 'shell', granted: false, decidedAt: 5 }];
    mutateImpl.mockResolvedValue(merged);
    const a = makeFakeWin();
    const b = makeFakeWin();
    h.windows.push(a, b);

    const mutation = { kind: 'set', perms: ['shell'], granted: false };
    await expect(mutate({ id: ID, mutation })).resolves.toEqual({ ok: true, data: merged });

    expect(mutateImpl).toHaveBeenCalledWith(expect.any(String), ID, mutation);
    expect(changedSends(a)).toEqual([{ id: ID }]);
    expect(changedSends(b)).toEqual([{ id: ID }]);
  });

  it('写失败 → 不广播', async () => {
    mutateImpl.mockRejectedValue(Object.assign(new Error('disk'), { code: 'EIO' }));
    const a = makeFakeWin();
    h.windows.push(a);
    await expect(
      mutate({ id: ID, mutation: { kind: 'clear-denied' } }),
    ).resolves.toMatchObject({ ok: false });
    expect(changedSends(a)).toEqual([]);
  });

  it('不受信 frame → 拒绝,不写不广播', async () => {
    const a = makeFakeWin();
    h.windows.push(a);
    await expect(
      mutate({ id: ID, mutation: { kind: 'clear-denied' } }, { senderFrame: { url: 'https://evil.example/' } }),
    ).resolves.toMatchObject({ ok: false });
    expect(mutateImpl).not.toHaveBeenCalled();
    expect(changedSends(a)).toEqual([]);
  });
});

describe('MutatePluginPermissionsInput schema', () => {
  it('合法 set / clear-denied → ok', () => {
    expect(
      MutatePluginPermissionsInput.safeParse({
        id: ID,
        mutation: { kind: 'set', perms: ['fs', 'shell'], granted: true },
      }).success,
    ).toBe(true);
    expect(
      MutatePluginPermissionsInput.safeParse({ id: ID, mutation: { kind: 'clear-denied' } }).success,
    ).toBe(true);
  });

  it('未知权限名 / 未知 kind / 额外字段 / 空 perms / 超长 id → fail', () => {
    const bad = [
      { id: ID, mutation: { kind: 'set', perms: ['root'], granted: true } },
      { id: ID, mutation: { kind: 'replace', perms: ['fs'], granted: true } },
      { id: ID, mutation: { kind: 'set', perms: ['fs'], granted: true, decidedAt: 1 } },
      { id: ID, mutation: { kind: 'set', perms: [], granted: true } },
      { id: 'x'.repeat(257), mutation: { kind: 'clear-denied' } },
    ];
    for (const input of bad) {
      expect(MutatePluginPermissionsInput.safeParse(input).success).toBe(false);
    }
  });
});
