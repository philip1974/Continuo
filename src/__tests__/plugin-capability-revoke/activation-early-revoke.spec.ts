// @vitest-environment jsdom
// 激活早期的禁用 / 卸载(终审 P1,见同目录 README.md 1c):
// 1. init 读取启用快照后,某插件尚未写入 entries(前一个插件挂在授权弹窗上)时收到其禁用广播 → 该插件不得再按旧快照
//    import / 激活;之后的 enabled=true 广播清除该标记。
// 2. 模块顶层 await 永不结束(import 挂起)时禁用 / 卸载 → 管理器停止等待 import、按禁用收尾、释放生命周期锁;
//    import 迟到完成也不构造实例。
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: async () => ({ token: 'tok' }),
      _unregisterPlugin: async () => undefined,
    },
    plugins: {
      readPermissions: async () => ({ ok: true, data: {} }),
      mutatePluginPermissions: async () => ({ ok: true, data: null }),
    },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost } from '../../plugins/PluginManager';
import { IpcPermissionStore } from '../../plugins/permissions/IpcPermissionStore';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';
import { wirePluginEvents } from '../../plugins/plugin-events';
import { createTestCoApp } from '../../plugins/test-utils';
import { flushMacrotasks } from '../_helpers/async';

const A = 'com.x.a';
const B = 'com.x.b';

const constructed = vi.fn();
class P extends Plugin {
  constructor(...args: ConstructorParameters<typeof Plugin>) {
    super(...args);
    constructed(this.manifest.id);
  }
  onload() {}
}

function manifest(id: string, permissions?: string[]): string {
  return JSON.stringify({ id, name: id, version: '0.1.0', ...(permissions ? { permissions } : {}) });
}

/** 按 main-app 的接线方式(先发起 init,再 wirePluginEvents),返回广播触发器。 */
function wire(mgr: PluginManager): { emitEnabled: (id: string, enabled: boolean) => void } {
  let onEnabled!: (id: string, enabled: boolean) => void;
  void mgr.init().catch(() => {});
  wirePluginEvents(
    mgr,
    {
      onChanged: () => {},
      onUninstalled: () => {},
      onEnabledChanged: (cb) => {
        onEnabled = cb;
      },
    },
    () => {},
  );
  return { emitEnabled: (id, on) => onEnabled(id, on) };
}

beforeEach(() => {
  constructed.mockClear();
  usePermissionPromptStore.getState().cancel(A, new Error('reset'));
});

describe('init 期间尚无 entry 的插件收到禁用广播', () => {
  function makeWindow(): { mgr: PluginManager; importModule: ReturnType<typeof vi.fn> } {
    const importModule = vi.fn(async () => ({ default: P }));
    const host: ManagerHost = {
      // A 声明权限 → init 激活 A 时挂在授权弹窗上;B 排在其后,此时尚未激活(扫描阶段已登记 entry,见 whenScanned)。
      listPluginDirs: () => [
        { id: A, manifestText: manifest(A, ['shell']), moduleUrl: `mod://${A}` },
        { id: B, manifestText: manifest(B), moduleUrl: `mod://${B}` },
      ],
      readEnabledIds: () => new Set([A, B]),
      mutateEnabledId: () => {},
      importModule,
      permissionStore: new IpcPermissionStore(),
      promptFn: (pid, perms) => usePermissionPromptStore.getState().request(pid, perms),
    };
    return { mgr: new PluginManager(createTestCoApp('1.0.0'), host), importModule };
  }

  it('B 不被 import / 构造,init 后为 disabled', async () => {
    const { mgr, importModule } = makeWindow();
    const { emitEnabled } = wire(mgr);
    await flushMacrotasks(1);
    expect(usePermissionPromptStore.getState().pending).toMatchObject({ pluginId: A });
    expect(mgr.listAll().map((p) => p.id)).toEqual([A, B]); // 两阶段 init:B 已登记、尚未激活
    expect(importModule).not.toHaveBeenCalledWith(`mod://${B}`);

    emitEnabled(B, false);
    usePermissionPromptStore.getState().grant(['shell']);
    await flushMacrotasks(1);
    await flushMacrotasks(1);

    expect(importModule).not.toHaveBeenCalledWith(`mod://${B}`);
    expect(constructed).not.toHaveBeenCalledWith(B);
    expect(mgr.listAll().find((p) => p.id === B)?.status).toBe('disabled');
    expect(mgr.listAll().find((p) => p.id === A)?.status).toBe('enabled');
  });

  it('禁用后又收到 enabled=true 广播 → 标记清除,B 照常激活', async () => {
    const { mgr, importModule } = makeWindow();
    const { emitEnabled } = wire(mgr);
    await flushMacrotasks(1);
    emitEnabled(B, false);
    emitEnabled(B, true);
    usePermissionPromptStore.getState().grant(['shell']);
    await flushMacrotasks(1);
    await flushMacrotasks(1);

    expect(importModule).toHaveBeenCalledWith(`mod://${B}`);
    expect(mgr.listAll().find((p) => p.id === B)?.status).toBe('enabled');
  });
});

describe('模块顶层 await 永不结束(import 挂起)时禁用 / 卸载', () => {
  function makeHanging(enabled: boolean): {
    mgr: PluginManager;
    mutate: ReturnType<typeof vi.fn>;
    finishImport: () => void;
  } {
    let finishImport!: () => void;
    const pending = new Promise<unknown>((r) => (finishImport = () => r({ default: P })));
    const mutate = vi.fn();
    const host: ManagerHost = {
      listPluginDirs: () => [{ id: A, manifestText: manifest(A), moduleUrl: `mod://${A}` }],
      readEnabledIds: () => new Set(enabled ? [A] : []),
      mutateEnabledId: mutate,
      importModule: () => pending,
      removePluginDir: async () => {},
    };
    return { mgr: new PluginManager(createTestCoApp('1.0.0'), host), mutate, finishImport };
  }

  it('本地禁用:不再等 import,禁用完成并落盘 enabled=false;import 迟到完成也不构造实例', async () => {
    const { mgr, mutate, finishImport } = makeHanging(true);
    const init = mgr.init();
    await flushMacrotasks(1);

    await mgr.disable(A);
    await init;
    expect(mgr.listAll()[0]!.status).toBe('disabled');
    expect(mutate).toHaveBeenCalledWith(A, false);

    finishImport();
    await flushMacrotasks(1);
    expect(constructed).not.toHaveBeenCalled();
    expect(mgr.listAll()[0]!.status).toBe('disabled');
  });

  it('init 激活挂在 import 上时别窗禁用:init 完成、锁释放,之后可再启用', async () => {
    const { mgr } = makeHanging(true);
    const { emitEnabled } = wire(mgr);
    await flushMacrotasks(1);
    emitEnabled(A, false);
    await flushMacrotasks(1);
    await flushMacrotasks(1);
    expect(mgr.listAll()[0]!.status).toBe('disabled');
    // 锁已释放:后续生命周期操作不被挂起的 import 卡住
    await expect(mgr.disable(A)).resolves.toBeUndefined();
  });

  it('本地卸载:不再等 import,卸载完成', async () => {
    const { mgr } = makeHanging(true);
    const init = mgr.init();
    await flushMacrotasks(1);
    await mgr.uninstall(A);
    await init;
    expect(mgr.listAll()).toEqual([]);
  });
});
