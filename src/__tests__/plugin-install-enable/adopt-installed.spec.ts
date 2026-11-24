// @vitest-environment jsdom
// 安装即启用(renderer 侧):PluginManager.adoptInstalled 不重启即登记新装插件并按 _enabled.json 激活(照常走授权)。
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: vi.fn().mockResolvedValue({ token: 't', generation: 1 }),
      _unregisterPlugin: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost, type PluginDirInfo } from '../../plugins/PluginManager';
import { createTestCoApp } from '../../plugins/test-utils';
import { InMemoryPermissionStore } from '../../plugins/testing/in-memory-stores';
import type { PermissionKey } from '../../plugins/permissions';

const app = createTestCoApp('1.0.0');

class Loaded extends Plugin {
  static ids: string[] = [];
  onload() {
    Loaded.ids.push(this.manifest.id);
  }
}

interface State {
  dirs: PluginDirInfo[];
  enabled: Set<string>;
}

function dir(id: string, extra: Record<string, unknown> = {}): PluginDirInfo {
  return {
    id,
    manifestText: JSON.stringify({ id, name: id, version: '0.1.0', ...extra }),
    moduleUrl: `mod://${id}`,
  };
}

function host(state: State, over: Partial<ManagerHost> = {}): ManagerHost {
  return {
    listPluginDirs: () => state.dirs,
    readEnabledIds: () => state.enabled,
    mutateEnabledId: (id, enabled) => {
      if (enabled) state.enabled.add(id);
      else state.enabled.delete(id);
    },
    importModule: async () => ({ default: Loaded }),
    removePluginDir: async (id) => {
      state.dirs = state.dirs.filter((d) => d.id !== id);
      state.enabled.delete(id);
    },
    ...over,
  };
}

beforeEach(() => {
  Loaded.ids = [];
});

describe('PluginManager.adoptInstalled', () => {
  it('新装插件(main 已写启用)→ 不重启即进列表并激活', async () => {
    const state: State = { dirs: [], enabled: new Set() };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    // 安装:目录落盘 + main 写入启用
    state.dirs.push(dir('x'));
    state.enabled.add('x');

    await expect(mgr.adoptInstalled('x')).resolves.toBe(true);

    expect(mgr.listAll().find((p) => p.id === 'x')?.status).toBe('enabled');
    expect(Loaded.ids).toEqual(['x']);
  });

  it('_enabled.json 未记启用(写失败)→ 进列表但保持禁用,不激活', async () => {
    const state: State = { dirs: [], enabled: new Set() };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    state.dirs.push(dir('x'));

    await mgr.adoptInstalled('x');

    expect(mgr.listAll().find((p) => p.id === 'x')?.status).toBe('disabled');
    expect(Loaded.ids).toEqual([]);
  });

  it('声明权限 → 激活前照常弹授权(拒绝 → failed,不激活)', async () => {
    const state: State = { dirs: [], enabled: new Set() };
    const promptFn = vi.fn(async (): Promise<readonly PermissionKey[]> => []);
    const mgr = new PluginManager(
      app,
      host(state, { permissionStore: new InMemoryPermissionStore(), promptFn }),
    );
    await mgr.init();
    state.dirs.push(dir('x', { permissions: ['network'] }));
    state.enabled.add('x');

    await mgr.adoptInstalled('x');

    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(mgr.listAll().find((p) => p.id === 'x')?.status).toBe('failed');
    expect(Loaded.ids).toEqual([]);
  });

  it('已在列表 → 无操作(不重复激活)', async () => {
    const state: State = { dirs: [dir('x')], enabled: new Set(['x']) };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    expect(Loaded.ids).toEqual(['x']);

    await mgr.adoptInstalled('x');

    expect(Loaded.ids).toEqual(['x']);
  });

  it('目录不存在 / 准入不过 → false,列表不变', async () => {
    const state: State = { dirs: [], enabled: new Set(['x']) };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();

    await expect(mgr.adoptInstalled('x')).resolves.toBe(false);
    state.dirs.push(dir('y', { minLMVersion: '99.0.0' }));
    await expect(mgr.adoptInstalled('y')).resolves.toBe(false);

    expect(mgr.listAll()).toEqual([]);
  });

  it('同会话卸载后重装同 id → 重装即激活(不被先前的卸载意图挡住)', async () => {
    const state: State = { dirs: [dir('x')], enabled: new Set(['x']) };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    await mgr.uninstall('x');
    expect(mgr.listAll()).toEqual([]);

    state.dirs.push(dir('x'));
    state.enabled.add('x');
    await mgr.adoptInstalled('x');

    expect(mgr.listAll().find((p) => p.id === 'x')?.status).toBe('enabled');
    expect(Loaded.ids).toEqual(['x', 'x']);
  });

  it('登记前别的窗口卸载了它(卸载广播先到)→ 不激活', async () => {
    const state: State = { dirs: [], enabled: new Set() };
    const mgr = new PluginManager(app, host(state));
    await mgr.init();
    state.dirs.push(dir('x'));
    state.enabled.add('x');

    const adopting = mgr.adoptInstalled('x');
    mgr.markUninstalled('x'); // 卸载广播的同步部分,在 adopt 进锁前到达
    await adopting;

    expect(Loaded.ids).toEqual([]);
  });
});
