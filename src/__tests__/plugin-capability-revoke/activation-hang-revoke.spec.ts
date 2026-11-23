// @vitest-environment jsdom
// 停用即吊销 —— onload 挂起(终审 P1):插件在 onload 里起定时器 / shell 后 await 永不结束的 Promise,激活一直持有
// 生命周期锁、init 一直不完成。禁用 / 卸载(本地或别的窗口广播)必须**锁外立即**吊销 scoped app + 终止 shell 进程,
// 不等 onload、不等 init;并中止挂起的激活等待,让锁释放、排队的停用照常完成。见同目录 README.md。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ shellExec: vi.fn() }));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: async () => ({ token: 'tok' }),
      _unregisterPlugin: async () => undefined,
    },
    shell: { exec: h.shellExec },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost } from '../../plugins/PluginManager';
import { wirePluginReloadGate } from '../../plugins/plugin-reload-gate';
import { createTestCoApp } from '../../plugins/test-utils';

const ID = 'com.x.hang';
const flush = () => new Promise((r) => setTimeout(r, 0));

/** onload 里留一个延迟回调(模拟定时器),然后永远挂起。 */
let later: (() => Promise<unknown>) | null = null;
class Hanging extends Plugin {
  onload() {
    later = () => this.app.shell.exec('echo', ['hi']);
    return new Promise<void>(() => {});
  }
}

function makeManager(enabled: boolean): {
  mgr: PluginManager;
  kill: ReturnType<typeof vi.fn>;
  mutate: ReturnType<typeof vi.fn>;
} {
  const kill = vi.fn().mockResolvedValue(undefined);
  const mutate = vi.fn();
  const host: ManagerHost = {
    listPluginDirs: () => [
      { id: ID, manifestText: JSON.stringify({ id: ID, name: 'h', version: '0.1.0' }), moduleUrl: 'mod://h' },
    ],
    readEnabledIds: () => new Set(enabled ? [ID] : []),
    mutateEnabledId: mutate,
    importModule: async () => ({ default: Hanging }),
    removePluginDir: async () => {},
    killPluginShellProcesses: kill,
  };
  return { mgr: new PluginManager(createTestCoApp('1.0.0'), host), kill, mutate };
}

/** 按 main-app 的接线方式接 reload-gate,返回广播触发器。 */
function wire(mgr: PluginManager): {
  emitEnabled: (id: string, enabled: boolean) => void;
  emitUninstalled: (id: string) => void;
} {
  let onEnabled!: (id: string, enabled: boolean) => void;
  let onUninstalled!: (id: string) => void;
  wirePluginReloadGate({
    init: () => mgr.init(),
    reload: (id) => mgr.reload(id),
    onChanged: () => {},
    onUninstalled: (cb) => {
      onUninstalled = cb;
    },
    uninstalled: (id) => mgr.handleUninstalled(id),
    markUninstalled: (id) => mgr.markUninstalled(id),
    onEnabledChanged: (cb) => {
      onEnabled = cb;
    },
    enabledChanged: (id, on) => mgr.handleEnabledChanged(id, on),
    revokeImmediately: (id) => mgr.revokeImmediately(id),
  });
  return { emitEnabled: (id, on) => onEnabled(id, on), emitUninstalled: (id) => onUninstalled(id) };
}

beforeEach(() => {
  later = null;
  h.shellExec.mockReset().mockResolvedValue({ ok: true, data: { stdout: '', stderr: '', exitCode: 0 } });
});

describe('onload 挂起期间收到禁用 / 卸载 → 立即吊销,不等 onload / init', () => {
  it('别窗禁用广播(init 未完成):立即吊销 —— 之后 shell.exec 被拒、不发 IPC;终止 IPC 立即被调用', async () => {
    const { mgr, kill } = makeManager(true);
    const { emitEnabled } = wire(mgr);
    await flush();
    expect(later).not.toBeNull(); // onload 已开始并挂起
    expect(kill).not.toHaveBeenCalled();

    emitEnabled(ID, false);
    // 同步:不等 onload 返回、不等 init 完成
    expect(kill).toHaveBeenCalledWith(ID);
    await expect(later!()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(h.shellExec).not.toHaveBeenCalled();

    // 挂起的激活被中止 → 锁释放、init 完成,缓冲的禁用随后落地
    await flush();
    await flush();
    expect(mgr.listAll()[0]!.status).toBe('disabled');
  });

  it('别窗卸载广播(init 未完成):立即吊销 + 终止进程,随后 entry 被移除', async () => {
    const { mgr, kill } = makeManager(true);
    const { emitUninstalled } = wire(mgr);
    await flush();
    emitUninstalled(ID);
    expect(kill).toHaveBeenCalledWith(ID);
    await expect(later!()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await flush();
    await flush();
    expect(mgr.listAll()).toEqual([]);
  });

  it('本窗口点禁用(启用的激活挂在 onload):立即吊销 + 终止进程;禁用完成并落盘', async () => {
    const { mgr, kill, mutate } = makeManager(false);
    await mgr.init();
    const enabling = mgr.enable(ID);
    await flush();
    expect(later).not.toBeNull();

    const disabling = mgr.disable(ID);
    expect(kill).toHaveBeenCalledWith(ID);
    await expect(later!()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await enabling;
    await disabling;
    expect(mgr.listAll()[0]!.status).toBe('disabled');
    expect(mutate).not.toHaveBeenCalledWith(ID, true);
  });

  it('init 时激活挂起,本窗口点禁用:禁用落盘 enabled=false', async () => {
    const { mgr, mutate } = makeManager(true);
    const init = mgr.init();
    await flush();
    await mgr.disable(ID);
    await init;
    expect(mgr.listAll()[0]!.status).toBe('disabled');
    expect(mutate).toHaveBeenCalledWith(ID, false);
  });
});
