// @vitest-environment jsdom
// 跨窗口卸载:renderer 收到 plugins:uninstalled 后停用实例、注销贡献点、失效权限缓存(终审 P1)。
// 每个窗口各有一个 PluginManager + IpcPermissionStore;这里用两个 manager 模拟窗口 A / B。见同目录 README.md。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  // main 侧 _permissions.json 的内存替身(两窗共享)
  disk: {} as Record<string, unknown>,
  pluginFsRaw: {
    _registerPlugin: async () => ({ token: 'tok' }),
    _unregisterPlugin: async () => undefined,
  },
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: h.pluginFsRaw,
    plugins: {
      readPermissions: async () => ({ ok: true, data: structuredClone(h.disk) }),
      // 本规范的授权已在盘上(promptFn 不会被触发),变更 IPC 不应被调用;调用即失败暴露。
      mutatePluginPermissions: async () => {
        throw new Error('unexpected mutatePluginPermissions');
      },
    },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost, type PluginDirInfo } from '../../plugins/PluginManager';
import { IpcPermissionStore } from '../../plugins/permissions/IpcPermissionStore';
import { wirePluginReloadGate } from '../../plugins/plugin-reload-gate';
import { createTestCoApp } from '../../plugins/test-utils';
import type { CoApp } from '../../plugins/types';

const ID = 'com.x.p';

class ShellPlugin extends Plugin {
  static instances: ShellPlugin[] = [];
  static unloaded = 0;
  onload() {
    ShellPlugin.instances.push(this);
    this.addCommand({ id: `${ID}.run`, title: 'Run', fn: () => {} });
  }
  onunload() {
    ShellPlugin.unloaded += 1;
  }
}

interface Shared {
  dirs: PluginDirInfo[];
  enabled: Set<string>;
  removed: string[];
}

function makeWindow(shared: Shared): {
  app: CoApp;
  mgr: PluginManager;
  store: IpcPermissionStore;
  mutateEnabledId: ReturnType<typeof vi.fn>;
  removePluginDir: ReturnType<typeof vi.fn>;
} {
  const app = createTestCoApp('1.0.0');
  const store = new IpcPermissionStore();
  const mutateEnabledId = vi.fn((id: string, on: boolean) => {
    if (on) shared.enabled.add(id);
    else shared.enabled.delete(id);
  });
  const removePluginDir = vi.fn(async (id: string) => {
    shared.removed.push(id);
    shared.dirs = shared.dirs.filter((d) => d.id !== id);
    delete h.disk[id]; // main 卸载同时清 _permissions.json
  });
  const host: ManagerHost = {
    listPluginDirs: () => shared.dirs,
    readEnabledIds: () => shared.enabled,
    mutateEnabledId,
    importModule: async () => ({ default: ShellPlugin }),
    permissionStore: store,
    promptFn: async (_id, perms) => perms,
    removePluginDir,
  };
  return { app, mgr: new PluginManager(app, host), store, mutateEnabledId, removePluginDir };
}

function freshShared(): Shared {
  return {
    dirs: [
      {
        id: ID,
        manifestText: JSON.stringify({ id: ID, name: 'p', version: '0.1.0', permissions: ['shell'] }),
        moduleUrl: 'mod://p',
      },
    ],
    enabled: new Set([ID]),
    removed: [],
  };
}

beforeEach(() => {
  h.disk = { [ID]: [{ permission: 'shell', granted: true, decidedAt: 1 }] };
  ShellPlugin.instances = [];
  ShellPlugin.unloaded = 0;
});

describe('renderer:收到 plugins:uninstalled 后撤销本窗口的插件实例与授权', () => {
  it('窗口 A 卸载后,窗口 B 收到广播:实例停用、贡献点注销、权限查询不再放行;不触碰磁盘', async () => {
    const shared = freshShared();
    const a = makeWindow(shared);
    const b = makeWindow(shared);
    await a.mgr.init();
    await b.mgr.init();
    const instB = ShellPlugin.instances[1]!;
    expect(b.app.commands.getAll().map((c) => c.id)).toEqual([`${ID}.run`]);
    // B 的授权缓存已加载(激活时读过)
    expect(await instB.app.permission.check('shell')).toBe(true);

    await a.mgr.uninstall(ID);
    // A 本地卸载完成;B 此时仍存活(修复前的缺陷形态)
    expect(b.mgr.listAll().map((p) => p.id)).toEqual([ID]);

    b.mutateEnabledId.mockClear();
    await b.mgr.handleUninstalled(ID);

    expect(ShellPlugin.unloaded).toBe(2);
    expect(b.mgr.listAll()).toEqual([]);
    expect(b.app.commands.getAll()).toEqual([]);
    expect(await instB.app.permission.check('shell')).toBe(false);
    expect(await b.store.get(ID)).toEqual([]);
    // 不再触碰磁盘:不写 _enabled.json、不删目录
    expect(b.mutateEnabledId).not.toHaveBeenCalled();
    expect(b.removePluginDir).not.toHaveBeenCalled();
    expect(shared.removed).toEqual([ID]);
  });

  it('发起卸载的窗口自身也会收到广播:幂等(不抛、不重复停用),并清掉本窗口的权限缓存', async () => {
    const shared = freshShared();
    const a = makeWindow(shared);
    await a.mgr.init();
    expect(await a.store.get(ID)).toHaveLength(1);

    await a.mgr.uninstall(ID);
    await expect(a.mgr.handleUninstalled(ID)).resolves.toBeUndefined();
    await expect(a.mgr.handleUninstalled(ID)).resolves.toBeUndefined();

    expect(ShellPlugin.unloaded).toBe(1);
    expect(a.removePluginDir).toHaveBeenCalledTimes(1);
    expect(await a.store.get(ID)).toEqual([]);
  });

  // perf(#2):插件数据缓存(dataStore,单插件最多 16MiB)在卸载后淘汰 —— 本地卸载成功与收到卸载广播都调
  // dataStore.forget(id);禁用不淘汰(重新启用仍要用数据)。
  it('卸载淘汰本窗口插件数据缓存:本地卸载与卸载广播都调 dataStore.forget,禁用不调', async () => {
    const shared = freshShared();
    const a = makeWindow(shared);
    const b = makeWindow(shared);
    const forgetA = vi.fn();
    const forgetB = vi.fn();
    a.app.dataStore.forget = forgetA;
    b.app.dataStore.forget = forgetB;
    await a.mgr.init();
    await b.mgr.init();

    await a.mgr.disable(ID);
    expect(forgetA).not.toHaveBeenCalled();

    await a.mgr.uninstall(ID);
    expect(forgetA).toHaveBeenCalledWith(ID);
    await b.mgr.handleUninstalled(ID);
    expect(forgetB).toHaveBeenCalledWith(ID);
  });

  it('IpcPermissionStore.forget:权限缓存加载途中收到卸载 → 加载结果里也剔除该插件', async () => {
    const store = new IpcPermissionStore();
    const pending = store.get(ID); // 发起加载(读到的是卸载前的快照)
    store.forget(ID);
    expect(await pending).toEqual([]);
    expect(await store.get(ID)).toEqual([]);
  });
});

describe('renderer 接线:wirePluginReloadGate 订阅 plugins:uninstalled', () => {
  it('init 完成后的卸载广播直接交给 handleUninstalled', async () => {
    const uninstalled = vi.fn().mockResolvedValue(undefined);
    let cb!: (id: string) => void;
    wirePluginReloadGate({
      init: async () => {},
      reload: vi.fn().mockResolvedValue(undefined),
      onChanged: () => {},
      onUninstalled: (fn) => {
        cb = fn;
      },
      uninstalled,
    });
    await Promise.resolve();
    await Promise.resolve();
    cb(ID);
    expect(uninstalled).toHaveBeenCalledWith(ID);
  });

  it('init 完成前到达的卸载广播先缓冲,init 完成后再处理(不被 init 的旧快照复活)', async () => {
    let finishInit!: () => void;
    const uninstalled = vi.fn().mockResolvedValue(undefined);
    let cb!: (id: string) => void;
    wirePluginReloadGate({
      init: () => new Promise<void>((r) => (finishInit = r)),
      reload: vi.fn().mockResolvedValue(undefined),
      onChanged: () => {},
      onUninstalled: (fn) => {
        cb = fn;
      },
      uninstalled,
    });
    cb(ID);
    await Promise.resolve();
    expect(uninstalled).not.toHaveBeenCalled();
    finishInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(uninstalled).toHaveBeenCalledWith(ID);
  });
});
