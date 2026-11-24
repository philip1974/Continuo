// @vitest-environment jsdom
// 跨窗口安装、授权在发起窗口(A)决定后,收到 plugins:installed 的窗口(B)跟进(见同目录 README「跨窗口」):
// - B 以「只登记」(prompt: false、授权尚未决定)登记的条目,在 A 授权后 main 广播 plugins:permissions-changed 时
//   B 直接激活(_enabled 里仍启用、已无未决定权限),不弹授权窗;
// - 尚未决定期间,B 插件页该行提示「已在其他窗口安装,等待授权 / 点启用在本窗口加载」,不只显示一个让人误解的「启用」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: vi.fn().mockResolvedValue({ token: 't', generation: 1 }),
      _unregisterPlugin: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import {
  PluginManager,
  setUserPluginManager,
  type ManagerHost,
  type PluginDirInfo,
} from '../../plugins/PluginManager';
import { createTestCoApp } from '../../plugins/test-utils';
import { InMemoryPermissionStore } from '../../plugins/testing/in-memory-stores';
import type { PermissionKey } from '../../plugins/permissions';
import { PluginsTabContent } from '../../plugins/settings/PluginsTabContent';
import { zh } from '../../../electron/shared/i18n-locales/zh';

const app = createTestCoApp('1.0.0');

class Loaded extends Plugin {
  static loads: string[] = [];
  onload() {
    Loaded.loads.push(this.manifest.id);
  }
}

interface Disk {
  dirs: PluginDirInfo[];
  enabled: Set<string>;
}

function dir(id: string, extra: Record<string, unknown> = {}): PluginDirInfo {
  return { id, manifestText: JSON.stringify({ id, name: id, version: '0.1.0', ...extra }), moduleUrl: `mod://${id}` };
}

function windowManager(disk: Disk, store: InMemoryPermissionStore, promptFn: ManagerHost['promptFn']): PluginManager {
  return new PluginManager(app, {
    listPluginDirs: () => disk.dirs,
    readEnabledIds: () => disk.enabled,
    mutateEnabledId: (id, enabled) => {
      if (enabled) disk.enabled.add(id);
      else disk.enabled.delete(id);
    },
    importModule: async () => ({ default: Loaded }),
    permissionStore: store,
    promptFn,
  });
}

const itemOf = (mgr: PluginManager, id: string) => mgr.listAll().find((p) => p.id === id);

/** A 发起安装、授权弹窗挂起;B 收到 plugins:installed(adoptInstalled prompt:false)只登记。 */
async function installedElsewhere() {
  const disk: Disk = { dirs: [], enabled: new Set() };
  const store = new InMemoryPermissionStore();
  let resolveA!: (granted: readonly PermissionKey[]) => void;
  const promptA = vi.fn(() => new Promise<readonly PermissionKey[]>((r) => (resolveA = r)));
  const promptB = vi.fn(async (): Promise<readonly PermissionKey[]> => ['network']);
  const a = windowManager(disk, store, promptA);
  const b = windowManager(disk, store, promptB);
  await Promise.all([a.init(), b.init()]);
  disk.dirs.push(dir('x', { permissions: ['network'] }));
  disk.enabled.add('x');
  const adoptA = a.adoptInstalled('x');
  await b.adoptInstalled('x', { prompt: false });
  return { disk, store, a, b, adoptA, promptB, grantInA: (g: readonly PermissionKey[]) => resolveA(g) };
}

beforeEach(() => {
  Loaded.loads = [];
});
afterEach(() => {
  cleanup();
  setUserPluginManager(null as unknown as PluginManager);
});

describe('B 跟进 A 的授权', () => {
  it('A 授权后 permissions-changed 到达 B → B 直接激活、不弹窗,等待提示消失', async () => {
    const { a, b, adoptA, promptB, grantInA } = await installedElsewhere();
    expect(itemOf(b, 'x')).toMatchObject({ status: 'disabled', awaitingGrantElsewhere: true });

    grantInA(['network']);
    await adoptA;
    expect(itemOf(a, 'x')?.status).toBe('enabled');

    await b.handlePermissionsChanged('x');
    expect(itemOf(b, 'x')?.status).toBe('enabled');
    expect(itemOf(b, 'x')?.awaitingGrantElsewhere).toBeUndefined();
    expect(promptB).not.toHaveBeenCalled();
    expect(Loaded.loads).toEqual(['x', 'x']);
  });

  it('权限仍有未决定的(变更的是别的记录)→ B 不激活,保留等待提示', async () => {
    const { b, promptB } = await installedElsewhere();
    await b.handlePermissionsChanged('x');
    expect(itemOf(b, 'x')).toMatchObject({ status: 'disabled', awaitingGrantElsewhere: true });
    expect(promptB).not.toHaveBeenCalled();
    expect(Loaded.loads).toEqual([]);
  });

  it('授权前插件已在别处被禁用(_enabled 不再记启用)→ 授权变更不激活', async () => {
    const { disk, store, b } = await installedElsewhere();
    disk.enabled.delete('x');
    await store.grant('x', ['network']);
    await b.handlePermissionsChanged('x');
    expect(itemOf(b, 'x')?.status).toBe('disabled');
    expect(Loaded.loads).toEqual([]);
  });

  it('等待期间别的窗口禁用了它(enabled-changed false)→ 等待提示消失、之后授权变更不激活', async () => {
    const { disk, store, b } = await installedElsewhere();
    disk.enabled.delete('x');
    await b.handleEnabledChanged('x', false);
    expect(itemOf(b, 'x')?.awaitingGrantElsewhere).toBeUndefined();
    await store.grant('x', ['network']);
    await b.handlePermissionsChanged('x');
    expect(itemOf(b, 'x')?.status).toBe('disabled');
  });

  it('B 用户在本窗口点启用(本窗口授权并加载)→ 等待提示消失', async () => {
    const { b } = await installedElsewhere();
    await b.enable('x');
    expect(itemOf(b, 'x')?.status).toBe('enabled');
    expect(itemOf(b, 'x')?.awaitingGrantElsewhere).toBeUndefined();
  });

  it('非跨窗登记的已禁用插件(用户自己禁用的)→ 授权变更不激活', async () => {
    const disk: Disk = { dirs: [dir('y', { permissions: ['network'] })], enabled: new Set() };
    const store = new InMemoryPermissionStore();
    await store.grant('y', ['network']);
    const b = windowManager(disk, store, vi.fn(async () => []));
    await b.init();
    disk.enabled.add('y'); // 即便盘上(另一窗口刚启用的广播尚未到)记启用,授权变更也不替启用广播做决定
    await b.handlePermissionsChanged('y');
    expect(itemOf(b, 'y')?.status).toBe('disabled');
    expect(itemOf(b, 'y')?.awaitingGrantElsewhere).toBeUndefined();
  });
});

describe('B 插件页提示', () => {
  it('等待其他窗口授权的行显示说明(role=status),激活后消失', async () => {
    const { b, adoptA, grantInA } = await installedElsewhere();
    setUserPluginManager(b);
    render(<PluginsTabContent />);
    expect(screen.getByText(zh['plugins_tab.user.awaiting_grant_elsewhere'])).toBeTruthy();
    expect(screen.getByText(zh['plugins_tab.user.awaiting_grant_elsewhere']).closest('[role="status"]')).not.toBeNull();

    grantInA(['network']);
    await adoptA;
    await b.handlePermissionsChanged('x');
    await vi.waitFor(() =>
      expect(screen.queryByText(zh['plugins_tab.user.awaiting_grant_elsewhere'])).toBeNull(),
    );
  });
});
