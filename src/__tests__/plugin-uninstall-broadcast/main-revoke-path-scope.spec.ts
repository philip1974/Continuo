// 卸载后同 id 插件不得静默继承内存中的 path-scope(安全)。见同目录 README.md。
//
// 根因:内存 PathScopeRegistry 只在 _unregister-plugin 且 token 为最新 generation 时 revokeAll。
// 插件 X 在窗口 A(gen1)与 B(gen2)都跑并获 scope → 关 B(不发 unregister)→ 在 A 卸载 X
//(gen1 非最新,跳过 revokeAll)→ 卸载只清盘,内存 scope 与 hydrated 标记残留 → 同会话从 URL
// 安装 manifest.id 同为 X 的仓库,新代码 request-scope 命中 covers() 静默拿到旧目录读写授权。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, raw: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  uninstallPlugin: { current: null as null | ((...args: unknown[]) => Promise<void>) },
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/continuo-test-user-data' },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { fromId: () => null, getAllWebContents: () => [] },
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
  mutatePluginPermissions: async () => null,
  readPluginPathScopes: async () => [],
  persistPluginPathScopesIfInstalled: async () => undefined,
}));

import { registerPluginsIpc } from '../../../electron/main/ipc/plugins.ipc';
import { registerPluginFsIpc } from '../../../electron/main/ipc/plugin-fs.ipc';
import { PLUGINS_CHANNELS } from '../../../electron/shared/plugins-channels';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

const RENDERER_URL = 'http://localhost:5173';
const TRUSTED = { senderFrame: { url: `${RENDERER_URL}/` } };
const ID = 'com.x.p';
const OTHER = 'com.x.other';
const SCOPE = [{ path: '/Users/victim/project', mode: 'rw' as const }];

function uninstall(id: string): Promise<unknown> {
  const fn = h.handlers.get(PLUGINS_CHANNELS.UNINSTALL);
  if (!fn) throw new Error('missing uninstall handler');
  return fn(TRUSTED, { id });
}

const savedEnv = process.env['ELECTRON_RENDERER_URL'];
let uninstallImpl: ReturnType<typeof vi.fn>;
let fsHandles: ReturnType<typeof registerPluginFsIpc>;

beforeEach(() => {
  process.env['ELECTRON_RENDERER_URL'] = RENDERER_URL;
  h.handlers.clear();
  uninstallImpl = vi.fn().mockResolvedValue(undefined);
  h.uninstallPlugin.current = uninstallImpl as unknown as (...args: unknown[]) => Promise<void>;
  registerPluginsIpc();
  fsHandles = registerPluginFsIpc({ ipcMain: { handle: vi.fn() } as never });
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env['ELECTRON_RENDERER_URL'];
  else process.env['ELECTRON_RENDERER_URL'] = savedEnv;
});

describe('main:卸载成功后撤销该插件的内存 path-scope 与 plugin-fs token', () => {
  it('旧 generation 窗口卸载(最新 generation 所在窗口已关、未发 unregister)→ 内存 scope 清空、需重新水合', async () => {
    const { identityRegistry, pathScopeRegistry } = fsHandles;
    const a = identityRegistry.register(ID, 1); // 窗口 A gen1
    identityRegistry.register(ID, 2); // 窗口 B gen2(随后关窗,不发 unregister)
    pathScopeRegistry.hydrate(ID, []);
    pathScopeRegistry.grant(ID, SCOPE);
    pathScopeRegistry.grant(OTHER, SCOPE);
    identityRegistry.revokeByWebContents(2); // 关 B

    await expect(uninstall(ID)).resolves.toMatchObject({ ok: true });

    expect(pathScopeRegistry._peek(ID)).toEqual([]);
    expect(pathScopeRegistry.covers(ID, SCOPE)).toBe(false);
    // hydrated 标记清除 → 重装后重新从(已清空的)磁盘水合
    expect(pathScopeRegistry.isHydrated(ID)).toBe(false);
    // 卸载意味着所有窗口的旧实例失效:token 不再 active,在途授权弹窗的 grant 不会落地复活 scope
    expect(identityRegistry.isActive(a.token)).toBe(false);
    // 其它插件不受影响
    expect(pathScopeRegistry._peek(OTHER)).toEqual(SCOPE);
  });

  it('卸载失败 → 不撤销(插件仍在盘上,各窗口照常运行)', async () => {
    const { identityRegistry, pathScopeRegistry } = fsHandles;
    const a = identityRegistry.register(ID, 1);
    pathScopeRegistry.grant(ID, SCOPE);
    uninstallImpl.mockRejectedValueOnce(
      Object.assign(new Error('rm failed'), { code: 'RM_FAILED' }),
    );

    await expect(uninstall(ID)).resolves.toMatchObject({ ok: false });
    expect(pathScopeRegistry._peek(ID)).toEqual(SCOPE);
    expect(identityRegistry.isActive(a.token)).toBe(true);
  });
});

describe('request-scope:冷启动水合在途时插件被卸载 → 不把卸载前读到的旧 scope 水合回内存', () => {
  it('loadPersistedScopes 挂起期间 token 被撤 → 不 hydrate,内存仍空、仍待重新水合', async () => {
    const ipc = new StubIpcMain();
    const identity = new IdentityRegistry();
    const scopes = new PathScopeRegistry(identity);
    const correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
    let releaseLoad!: (v: readonly { path: string; mode: 'r' | 'rw' }[]) => void;
    const loadStarted = vi.fn();
    registerPluginFsHandlers(ipc as never, {
      identityRegistry: identity,
      pathScopeRegistry: scopes,
      correlator,
      webContentsForSender: () => null,
      loadPersistedScopes: () => {
        loadStarted();
        return new Promise((r) => {
          releaseLoad = r;
        });
      },
    });
    const event = makeFakeEvent({ id: 1 });
    const { token } = identity.register(ID, 1);

    try {
      const pending = ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.REQUEST_SCOPE, token, SCOPE);
      void pending.catch(() => undefined);
      await vi.waitFor(() => expect(loadStarted).toHaveBeenCalled());
      // 卸载:token 撤销 + 内存 scope 清空(与卸载成功后主进程的撤销同效)
      identity.revoke(token);
      scopes.revokeAll(ID);
      // 卸载清盘前读到的旧快照此时才返回
      releaseLoad(SCOPE);
      await vi.waitFor(() => expect(event.sender.send).toHaveBeenCalled());

      expect(scopes._peek(ID)).toEqual([]);
      expect(scopes.isHydrated(ID)).toBe(false);
    } finally {
      correlator.dispose();
    }
  });
});
