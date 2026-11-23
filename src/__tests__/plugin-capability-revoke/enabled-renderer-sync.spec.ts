// @vitest-environment jsdom
// 跨窗口启用状态:各窗口收到 plugins:enabled-changed 后同步本窗口的插件实例(终审 P1)。
// 用两个 manager 模拟窗口 A / B。见同目录 README.md。
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: async () => ({ token: 'tok', generation: 1 }),
      _unregisterPlugin: async () => undefined,
    },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost, type PluginDirInfo } from '../../plugins/PluginManager';
import { wirePluginReloadGate } from '../../plugins/plugin-reload-gate';
import { createTestCoApp } from '../../plugins/test-utils';
import type { CoApp } from '../../plugins/types';
import { InMemoryPermissionStore } from '../../plugins/testing/in-memory-stores';

const ID = 'com.x.p';

class CmdPlugin extends Plugin {
  static loaded = 0;
  static unloaded = 0;
  onload() {
    CmdPlugin.loaded += 1;
    this.addCommand({ id: `${ID}.run`, title: 'Run', fn: () => {} });
  }
  onunload() {
    CmdPlugin.unloaded += 1;
  }
}

interface Shared {
  dirs: PluginDirInfo[];
  enabled: Set<string>;
  store: InMemoryPermissionStore;
}

function makeWindow(shared: Shared): {
  app: CoApp;
  mgr: PluginManager;
  mutateEnabledId: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
} {
  const app = createTestCoApp('1.0.0');
  const mutateEnabledId = vi.fn((id: string, on: boolean) => {
    if (on) shared.enabled.add(id);
    else shared.enabled.delete(id);
  });
  const prompt = vi.fn(async (_id: string, perms: readonly string[]) => perms);
  const host: ManagerHost = {
    listPluginDirs: () => shared.dirs,
    readEnabledIds: () => new Set(shared.enabled),
    mutateEnabledId,
    importModule: async () => ({ default: CmdPlugin }),
    permissionStore: shared.store,
    promptFn: prompt as never,
  };
  return { app, mgr: new PluginManager(app, host), mutateEnabledId, prompt };
}

async function freshShared(enabled: boolean): Promise<Shared> {
  const store = new InMemoryPermissionStore();
  await store.grant(ID, ['shell']);
  return {
    dirs: [
      {
        id: ID,
        manifestText: JSON.stringify({ id: ID, name: 'p', version: '0.1.0', permissions: ['shell'] }),
        moduleUrl: 'mod://p',
      },
    ],
    enabled: enabled ? new Set([ID]) : new Set(),
    store,
  };
}

beforeEach(() => {
  CmdPlugin.loaded = 0;
  CmdPlugin.unloaded = 0;
});

describe('renderer:收到 plugins:enabled-changed 后同步本窗口实例', () => {
  it('窗口 A 禁用 → B 收到 enabled=false:实例停用、命令注销、状态 disabled;不写盘', async () => {
    const shared = await freshShared(true);
    const a = makeWindow(shared);
    const b = makeWindow(shared);
    await a.mgr.init();
    await b.mgr.init();
    expect(b.app.commands.getAll().map((c) => c.id)).toEqual([`${ID}.run`]);

    await a.mgr.disable(ID);
    b.mutateEnabledId.mockClear();
    await b.mgr.handleEnabledChanged(ID, false);

    expect(CmdPlugin.unloaded).toBe(2);
    expect(b.app.commands.getAll()).toEqual([]);
    expect(b.mgr.listAll()[0]!.status).toBe('disabled');
    expect(b.mutateEnabledId).not.toHaveBeenCalled();
  });

  it('B 收到禁用后不会因随后的热重载复活(启用意图已清)', async () => {
    const shared = await freshShared(true);
    const b = makeWindow(shared);
    await b.mgr.init();
    await b.mgr.handleEnabledChanged(ID, false);
    await b.mgr.reload(ID);
    expect(CmdPlugin.loaded).toBe(1);
    expect(b.mgr.listAll()[0]!.status).toBe('disabled');
  });

  it('发起窗口自身也收到广播:幂等(不重复停用、不写盘)', async () => {
    const shared = await freshShared(true);
    const a = makeWindow(shared);
    await a.mgr.init();
    await a.mgr.disable(ID);
    a.mutateEnabledId.mockClear();
    await a.mgr.handleEnabledChanged(ID, false);
    await a.mgr.handleEnabledChanged(ID, false);
    expect(CmdPlugin.unloaded).toBe(1);
    expect(a.mutateEnabledId).not.toHaveBeenCalled();
  });

  it('窗口 A 启用 → B 收到 enabled=true:按已授权激活(不弹窗、不写盘);重复广播幂等', async () => {
    const shared = await freshShared(false);
    const a = makeWindow(shared);
    const b = makeWindow(shared);
    await a.mgr.init();
    await b.mgr.init();
    expect(CmdPlugin.loaded).toBe(0);

    await a.mgr.enable(ID);
    b.mutateEnabledId.mockClear();
    await b.mgr.handleEnabledChanged(ID, true);
    await b.mgr.handleEnabledChanged(ID, true);

    expect(CmdPlugin.loaded).toBe(2);
    expect(b.app.commands.getAll().map((c) => c.id)).toEqual([`${ID}.run`]);
    expect(b.mgr.listAll()[0]!.status).toBe('enabled');
    expect(b.mutateEnabledId).not.toHaveBeenCalled();
    expect(b.prompt).not.toHaveBeenCalled();
  });

  it('未知插件 id → 忽略,不抛', async () => {
    const shared = await freshShared(true);
    const b = makeWindow(shared);
    await b.mgr.init();
    await expect(b.mgr.handleEnabledChanged('com.unknown', false)).resolves.toBeUndefined();
    await expect(b.mgr.handleEnabledChanged('com.unknown', true)).resolves.toBeUndefined();
  });
});

describe('renderer 接线:wirePluginReloadGate 订阅 plugins:enabled-changed', () => {
  it('init 完成后的广播直接交给 enabledChanged', async () => {
    const enabledChanged = vi.fn().mockResolvedValue(undefined);
    let cb!: (id: string, enabled: boolean) => void;
    wirePluginReloadGate({
      init: async () => {},
      reload: vi.fn().mockResolvedValue(undefined),
      onChanged: () => {},
      onEnabledChanged: (fn) => {
        cb = fn;
      },
      enabledChanged,
    });
    await Promise.resolve();
    await Promise.resolve();
    cb(ID, false);
    expect(enabledChanged).toHaveBeenCalledWith(ID, false);
  });

  it('init 完成前到达的广播先缓冲(同 id 以最后一次为准),init 完成后再处理', async () => {
    let finishInit!: () => void;
    const enabledChanged = vi.fn().mockResolvedValue(undefined);
    let cb!: (id: string, enabled: boolean) => void;
    wirePluginReloadGate({
      init: () => new Promise<void>((r) => (finishInit = r)),
      reload: vi.fn().mockResolvedValue(undefined),
      onChanged: () => {},
      onEnabledChanged: (fn) => {
        cb = fn;
      },
      enabledChanged,
    });
    cb(ID, true);
    cb(ID, false);
    await Promise.resolve();
    expect(enabledChanged).not.toHaveBeenCalled();
    finishInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(enabledChanged).toHaveBeenCalledTimes(1);
    expect(enabledChanged).toHaveBeenCalledWith(ID, false);
  });
});
