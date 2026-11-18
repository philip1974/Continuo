// 撤销 `fs` 权限 → main 撤销该插件全部已批准的路径 scope(内存 + 持久化)。见同目录 README.md「撤销 fs」。
//
// 此前:plugin-fs 主进程不看 `fs` 权限项,只靠 renderer 的 ensurePerm;PathScopeRegistry 只在卸载 / 注销时
// revokeAll,且 `_plugin-path-scopes.json` 不动。权限编辑里撤销 `fs` 后再勾上,以前批准的所有路径不经弹窗
// 直接恢复(request-scope 命中 covers() 静默授予;重启后从磁盘水合同样恢复)。
// 真实 plugins.ipc + plugin-fs.ipc + plugins.service(临时 userData 目录),只替换 electron 与插件目录 watcher。
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  userData: '',
  /** 非 null 时,水合读盘(readPluginPathScopes)挂在这里,直到测试放行。 */
  loadGate: null as Promise<void> | null,
  loads: 0,
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? h.userData : join(h.userData, '..', name)),
    isPackaged: false,
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { fromId: () => null, getAllWebContents: () => [] },
}));

vi.mock('../../../electron/main/services/plugins.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/main/services/plugins.service')>()),
  createPluginsWatcher: () => ({ start: () => {}, stop: () => {}, ensureBaseline: async () => {} }),
  recoverInterruptedInstalls: async () => undefined,
  readPluginPathScopes: async (...a: Parameters<typeof import('../../../electron/main/services/plugins.service').readPluginPathScopes>) => {
    h.loads += 1;
    if (h.loadGate) await h.loadGate;
    const real = await importOriginal<typeof import('../../../electron/main/services/plugins.service')>();
    return real.readPluginPathScopes(...a);
  },
}));

import { registerPluginsIpc } from '../../../electron/main/ipc/plugins.ipc';
import { registerPluginFsIpc } from '../../../electron/main/ipc/plugin-fs.ipc';
import { writePluginPathScopes } from '../../../electron/main/services/plugins.service';
import { PLUGINS_CHANNELS } from '../../../electron/shared/plugins-channels';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';

const ID = 'com.x.fsrevoke';
const OTHER = 'com.x.other';
const roots: string[] = [];
let fsHandles: ReturnType<typeof registerPluginFsIpc>;
let scopeDir: string;

const event = (send = vi.fn(), id = 1) => ({
  sender: { id, send, isDestroyed: () => false },
  senderFrame: { url: 'file:///app/index.html' },
});

function invoke(channel: string, ev: unknown, ...args: unknown[]): Promise<unknown> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`missing handler ${channel}`);
  return fn(ev, ...args);
}

const setFs = (granted: boolean): Promise<unknown> =>
  invoke(PLUGINS_CHANNELS.MUTATE_PLUGIN_PERMISSIONS, event(), {
    id: ID,
    mutation: { kind: 'set', perms: ['fs'], granted },
  });

async function persistedScopes(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(
      await readFile(join(h.userData, 'plugins', '_plugin-path-scopes.json'), 'utf-8'),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

beforeEach(async () => {
  h.loadGate = null;
  h.loads = 0;
  const base = await mkdtemp(join(tmpdir(), 'continuo-fs-revoke-'));
  roots.push(base);
  h.userData = join(base, 'userData');
  await mkdir(join(h.userData, 'plugins', ID), { recursive: true });
  await mkdir(join(h.userData, 'plugins', OTHER), { recursive: true });
  scopeDir = join(base, 'project');
  await mkdir(scopeDir);
  scopeDir = realpathSync(scopeDir); // 授权落地的是 canonical 路径(与 request-scope 的 grant 同源)
  h.handlers.clear();
  registerPluginsIpc();
  fsHandles = registerPluginFsIpc({
    ipcMain: { handle: (c: string, fn: Handler) => h.handlers.set(c, fn) } as never,
  });
});

afterEach(async () => {
  for (const d of roots.splice(0)) await rm(d, { recursive: true, force: true });
});

/** 模拟「之前授予过 fs 并批准过 scopeDir」:内存 grant + 持久化。 */
async function seedApprovedScope(): Promise<void> {
  await setFs(true);
  const scope = [{ path: scopeDir, mode: 'rw' as const }];
  fsHandles.pathScopeRegistry.hydrate(ID, []);
  fsHandles.pathScopeRegistry.grant(ID, scope);
  fsHandles.pathScopeRegistry.grant(OTHER, scope);
  await writePluginPathScopes(join(h.userData, 'plugins'), ID, scope);
  await writePluginPathScopes(join(h.userData, 'plugins'), OTHER, scope);
}

describe('撤销 fs 权限 → 撤销该插件全部已批准的路径 scope', () => {
  it('授予 scope → 撤销 fs → 重新授予 fs → 再请求原路径要重新弹窗(此前静默授予)', async () => {
    await seedApprovedScope();
    await expect(setFs(false)).resolves.toMatchObject({ ok: true });
    await expect(setFs(true)).resolves.toMatchObject({ ok: true });

    const { token } = fsHandles.identityRegistry.register(ID, 1);
    const send = vi.fn();
    const ev = event(send);
    const pending = invoke(PLUGIN_FS_CHANNELS.REQUEST_SCOPE, ev, token, [
      { path: scopeDir, mode: 'rw' },
    ]);
    void pending.catch(() => undefined);
    // 弹窗(发 SCOPE_REQUEST)而不是直接 'grant'。
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(PLUGIN_FS_CHANNELS.SCOPE_REQUEST, expect.anything()),
    );
    const { requestId } = send.mock.calls.find(
      (c) => c[0] === PLUGIN_FS_CHANNELS.SCOPE_REQUEST,
    )![1] as { requestId: string };
    await invoke(PLUGIN_FS_CHANNELS.SCOPE_DECISION, ev, requestId, 'deny');
    await expect(pending).resolves.toBe('deny');
  });

  it('持久化的 _plugin-path-scopes.json 里该插件的 scope 已删除(重启后不水合);其它插件不受影响', async () => {
    await seedApprovedScope();
    expect(Object.keys(await persistedScopes())).toEqual(expect.arrayContaining([ID, OTHER]));
    await setFs(false);
    const persisted = await persistedScopes();
    expect(persisted[ID]).toBeUndefined();
    expect(persisted[OTHER]).toEqual([{ path: scopeDir, mode: 'rw' }]);
    expect(fsHandles.pathScopeRegistry._peek(ID)).toEqual([]);
    expect(fsHandles.pathScopeRegistry._peek(OTHER)).toEqual([{ path: scopeDir, mode: 'rw' }]);
  });

  it('撤销后本会话不再从磁盘水合(在途 / 之后的水合读不得把旧 scope 写回内存)', async () => {
    await seedApprovedScope();
    await setFs(false);
    expect(fsHandles.pathScopeRegistry.isHydrated(ID)).toBe(true);
    expect(fsHandles.pathScopeRegistry.covers(ID, [{ path: scopeDir, mode: 'r' }])).toBe(false);
  });

  it('挂起中的 scope 弹窗:撤销 fs → 弹窗被撤、请求方得到 deny,之后点「授权」送不到,scope 不落地不持久化(插件的任一实例)', async () => {
    await setFs(true);
    // 同一插件两个窗口的实例;挂起的请求来自后注册的那个(须枚举该插件全部 token)
    fsHandles.identityRegistry.register(ID, 1);
    const { token } = fsHandles.identityRegistry.register(ID, 2);
    const send = vi.fn();
    const ev = event(send, 2);
    const pending = invoke(PLUGIN_FS_CHANNELS.REQUEST_SCOPE, ev, token, [{ path: scopeDir, mode: 'rw' }]);
    void pending.catch(() => undefined);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(PLUGIN_FS_CHANNELS.SCOPE_REQUEST, expect.anything()),
    );
    const { requestId } = send.mock.calls.find(
      (c) => c[0] === PLUGIN_FS_CHANNELS.SCOPE_REQUEST,
    )![1] as { requestId: string };

    await expect(setFs(false)).resolves.toMatchObject({ ok: true });
    // 用户在弹窗撤掉之前点了「授权」:决定送不到(请求已结算)
    await expect(
      invoke(PLUGIN_FS_CHANNELS.SCOPE_DECISION, ev, requestId, 'grant'),
    ).rejects.toThrow();
    await expect(pending).resolves.toBe('deny');
    expect(send).toHaveBeenCalledWith(PLUGIN_FS_CHANNELS.SCOPE_REQUEST_CANCELLED, { requestId });
    expect(fsHandles.pathScopeRegistry._peek(ID)).toEqual([]);
    expect((await persistedScopes())[ID]).toBeUndefined();
    // 其它插件的请求不受影响(此处只确认没有误伤其 scope)
    expect(fsHandles.pathScopeRegistry._peek(OTHER)).toEqual([]);
  });

  it('撤销 fs 时请求还没走到弹窗(在途的水合读盘)→ 不再弹窗、请求方得到 deny、scope 不落地', async () => {
    await setFs(true);
    const { token } = fsHandles.identityRegistry.register(ID, 1);
    let open!: () => void;
    h.loadGate = new Promise<void>((r) => (open = r));
    const send = vi.fn();
    const pending = invoke(PLUGIN_FS_CHANNELS.REQUEST_SCOPE, event(send), token, [{ path: scopeDir, mode: 'rw' }]);
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(h.loads).toBe(1));
    await expect(setFs(false)).resolves.toMatchObject({ ok: true });
    open();
    await expect(pending).resolves.toBe('deny');
    expect(send).not.toHaveBeenCalledWith(PLUGIN_FS_CHANNELS.SCOPE_REQUEST, expect.anything());
    expect(fsHandles.pathScopeRegistry._peek(ID)).toEqual([]);
    expect((await persistedScopes())[ID]).toBeUndefined();
  });

  it('授予 fs、撤销其它权限 → 不动 scope', async () => {
    await seedApprovedScope();
    await invoke(PLUGINS_CHANNELS.MUTATE_PLUGIN_PERMISSIONS, event(), {
      id: ID,
      mutation: { kind: 'set', perms: ['network'], granted: false },
    });
    await setFs(true);
    expect(fsHandles.pathScopeRegistry._peek(ID)).toEqual([{ path: scopeDir, mode: 'rw' }]);
    expect((await persistedScopes())[ID]).toEqual([{ path: scopeDir, mode: 'rw' }]);
  });
});
