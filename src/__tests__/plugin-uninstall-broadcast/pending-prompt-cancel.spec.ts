// @vitest-environment jsdom
// 卸载后仍可授权并执行已删除插件(终审 P1):窗口 B 的授权弹窗挂起期间插件被窗口 A 卸载。B 收到 plugins:uninstalled
// 时**立即**(不等生命周期锁)标记该插件已卸载并取消其待决授权弹窗;在途激活在执行插件代码前检查该标记并中止,
// 授权不写盘。见同目录 README.md。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  disk: {} as Record<string, unknown>,
  mutate: vi.fn(),
  pluginFsRaw: {
    _registerPlugin: vi.fn(async () => ({ token: 'tok' })),
    _unregisterPlugin: async () => undefined,
  },
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: h.pluginFsRaw,
    plugins: {
      readPermissions: async () => ({ ok: true, data: structuredClone(h.disk) }),
      mutatePluginPermissions: (...args: unknown[]) => h.mutate(...args),
    },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost } from '../../plugins/PluginManager';
import { IpcPermissionStore } from '../../plugins/permissions/IpcPermissionStore';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { wirePluginReloadGate } from '../../plugins/plugin-reload-gate';
import { createTestCoApp } from '../../plugins/test-utils';
import { flushMicrotasks } from '../_helpers/async';

const ID = 'com.x.p';
const OTHER = 'com.x.other';

const constructed = vi.fn();
class Victim extends Plugin {
  onload() {
    constructed(this.manifest.id);
  }
}

function manifest(id: string): string {
  return JSON.stringify({ id, name: id, version: '0.1.0', permissions: ['shell'] });
}

function makeWindow(enabled: string[]): {
  mgr: PluginManager;
  importModule: ReturnType<typeof vi.fn>;
} {
  const importModule = vi.fn(async () => ({ default: Victim }));
  const host: ManagerHost = {
    listPluginDirs: () => [
      { id: ID, manifestText: manifest(ID), moduleUrl: `mod://${ID}` },
      { id: OTHER, manifestText: manifest(OTHER), moduleUrl: `mod://${OTHER}` },
    ],
    readEnabledIds: () => new Set(enabled),
    mutateEnabledId: () => {},
    importModule,
    permissionStore: new IpcPermissionStore(),
    // 生产接线同款:授权弹窗 = promptStore.request;卸载广播取消该插件的待决弹窗。
    promptFn: (pid, perms) => usePermissionPromptStore.getState().request(pid, perms),
    cancelPermissionPrompt: (pid, reason) =>
      usePermissionPromptStore.getState().cancel(pid, reason),
  };
  return { mgr: new PluginManager(createTestCoApp('1.0.0'), host), importModule };
}

/** 让在途的 Promise 链推进(授权读取 / 弹窗 / 激活各有若干 await)。 */

beforeEach(() => {
  h.disk = {};
  h.mutate.mockReset();
  h.mutate.mockResolvedValue({ ok: true, data: null });
  h.pluginFsRaw._registerPlugin.mockClear();
  constructed.mockClear();
  usePermissionPromptStore.getState().cancel(ID, new Error('reset'));
  usePermissionPromptStore.getState().cancel(OTHER, new Error('reset'));
});

describe('授权弹窗挂起期间收到卸载广播', () => {
  it('启用触发的弹窗被取消:插件代码未执行、权限未写入、entry 移除', async () => {
    const b = makeWindow([]);
    await b.mgr.init();
    const enabling = b.mgr.enable(ID);
    await flushMicrotasks(20);
    expect(usePermissionPromptStore.getState().pending).toMatchObject({ pluginId: ID });

    // 广播到达:生命周期锁被挂起的激活占着,但标记与取消立即生效
    const tearing = b.mgr.handleUninstalled(ID);
    expect(usePermissionPromptStore.getState().pending).toBeNull();
    await expect(enabling).resolves.toBeUndefined();
    await tearing;

    expect(b.importModule).not.toHaveBeenCalled();
    expect(constructed).not.toHaveBeenCalled();
    expect(h.pluginFsRaw._registerPlugin).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
    expect(b.mgr.listAll().map((p) => p.id)).toEqual([OTHER]);
  });

  it('用户已点授权、授权写入在途时收到广播:写入返回后也不加载插件代码', async () => {
    let finishWrite!: () => void;
    h.mutate.mockImplementation(
      () => new Promise((r) => (finishWrite = () => r({ ok: true, data: null }))),
    );
    const b = makeWindow([]);
    await b.mgr.init();
    const enabling = b.mgr.enable(ID);
    await flushMicrotasks(20);
    usePermissionPromptStore.getState().grant(['shell']);
    await flushMicrotasks(20);
    expect(h.mutate).toHaveBeenCalledTimes(1);

    const tearing = b.mgr.handleUninstalled(ID);
    finishWrite();
    await enabling;
    await tearing;

    expect(b.importModule).not.toHaveBeenCalled();
    expect(constructed).not.toHaveBeenCalled();
    expect(b.mgr.listAll().map((p) => p.id)).toEqual([OTHER]);
  });

  it('排队中的同插件弹窗一并取消,其它插件的弹窗不受影响', async () => {
    const other = usePermissionPromptStore.getState().request(OTHER, ['shell']);
    const queued = usePermissionPromptStore.getState().request(ID, ['shell']);
    usePermissionPromptStore.getState().cancel(ID, new Error('uninstalled'));
    await expect(queued).rejects.toThrow('uninstalled');
    expect(usePermissionPromptStore.getState().pending).toMatchObject({ pluginId: OTHER });
    usePermissionPromptStore.getState().grant(['shell']);
    await expect(other).resolves.toEqual(['shell']);
    expect(usePermissionPromptStore.getState().pending).toBeNull();
  });

  it('当前弹窗被取消后,队列里下一个插件的弹窗接着显示', async () => {
    const victim = usePermissionPromptStore.getState().request(ID, ['shell']);
    const next = usePermissionPromptStore.getState().request(OTHER, ['shell']);
    usePermissionPromptStore.getState().cancel(ID, new Error('uninstalled'));
    await expect(victim).rejects.toThrow('uninstalled');
    expect(usePermissionPromptStore.getState().pending).toMatchObject({ pluginId: OTHER });
    usePermissionPromptStore.getState().denyAll();
    await expect(next).resolves.toEqual([]);
  });
});

describe('init 激活挂在授权弹窗上时收到卸载广播(reload-gate 尚未 ready)', () => {
  it('gate 立即标记并取消弹窗,init 不加载插件代码、不写权限;init 完成后再执行卸载清理', async () => {
    const b = makeWindow([ID]);
    let onUninstalled!: (id: string) => void;
    const uninstalled = vi.fn((id: string) => b.mgr.handleUninstalled(id));
    wirePluginReloadGate({
      init: () => b.mgr.init(),
      reload: vi.fn().mockResolvedValue(undefined),
      onChanged: () => {},
      onUninstalled: (fn) => {
        onUninstalled = fn;
      },
      uninstalled,
      markUninstalled: (id) => b.mgr.markUninstalled(id),
    });
    await flushMicrotasks(20);
    expect(usePermissionPromptStore.getState().pending).toMatchObject({ pluginId: ID });

    onUninstalled(ID);
    expect(usePermissionPromptStore.getState().pending).toBeNull();
    await flushMicrotasks(20);
    await flushMicrotasks(20);

    expect(b.importModule).not.toHaveBeenCalled();
    expect(constructed).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
    expect(uninstalled).toHaveBeenCalledWith(ID);
    expect(b.mgr.listAll().map((p) => p.id)).toEqual([OTHER]);
  });
});
