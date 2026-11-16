// @vitest-environment jsdom
// 停用/卸载插件终止它启动的 shell 进程(终审 P1):renderer 侧给 shell 请求带上插件 id,
// 并在停用 / 卸载 / 远端卸载 / 重载时请求 main 终止该插件在本窗口的全部 shell 进程。见同目录 README.md。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  shellExec: vi.fn(),
  execStream: vi.fn(),
  killPluginProcesses: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: async () => ({ token: 'tok', generation: 1 }),
      _unregisterPlugin: async () => undefined,
    },
    shell: { exec: h.shellExec, killPluginProcesses: h.killPluginProcesses },
    pluginShellStreamRaw: { execStream: h.execStream },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost } from '../../plugins/PluginManager';
import { createScopedApp } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';
import { createWindowApiHost } from '../../lib/plugins-host';

const ID = 'com.x.p';

class NoopPlugin extends Plugin {
  onload() {}
}

function makeManager(): { mgr: PluginManager; kill: ReturnType<typeof vi.fn> } {
  const kill = vi.fn().mockResolvedValue(undefined);
  let dirs = [
    {
      id: ID,
      manifestText: JSON.stringify({ id: ID, name: 'p', version: '0.1.0' }),
      moduleUrl: 'mod://p',
    },
  ];
  const host: ManagerHost = {
    listPluginDirs: () => dirs,
    readEnabledIds: () => new Set([ID]),
    mutateEnabledId: () => {},
    importModule: async () => ({ default: NoopPlugin }),
    removePluginDir: async () => {
      dirs = [];
    },
    killPluginShellProcesses: kill,
  };
  return { mgr: new PluginManager(createTestCoApp('1.0.0'), host), kill };
}

beforeEach(() => {
  h.shellExec.mockReset().mockResolvedValue({
    ok: true,
    data: { stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false },
  });
  h.execStream.mockReset().mockReturnValue({
    chunks: { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) },
    done: Promise.resolve({ exitCode: 0, signal: null }),
  });
  h.killPluginProcesses.mockReset().mockResolvedValue({ ok: true, data: undefined });
});

describe('PluginManager:插件离开运行态时终止其 shell 进程', () => {
  it('disable → 以插件 id 请求终止', async () => {
    const { mgr, kill } = makeManager();
    await mgr.init();
    expect(kill).not.toHaveBeenCalled();
    await mgr.disable(ID);
    expect(kill).toHaveBeenCalledWith(ID);
  });

  it('uninstall → 请求终止', async () => {
    const { mgr, kill } = makeManager();
    await mgr.init();
    await mgr.uninstall(ID);
    expect(kill).toHaveBeenCalledWith(ID);
  });

  it('收到远端卸载广播(handleUninstalled)→ 请求终止', async () => {
    const { mgr, kill } = makeManager();
    await mgr.init();
    await mgr.handleUninstalled(ID);
    expect(kill).toHaveBeenCalledWith(ID);
  });

  it('reload(旧实例被替换)→ 请求终止旧实例的进程', async () => {
    const { mgr, kill } = makeManager();
    await mgr.init();
    await mgr.reload(ID);
    expect(kill).toHaveBeenCalledWith(ID);
  });

  it('终止请求失败只记录,不阻断停用', async () => {
    const { mgr, kill } = makeManager();
    kill.mockRejectedValue(new Error('ipc down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mgr.init();
    await expect(mgr.disable(ID)).resolves.toBeUndefined();
    expect(mgr.listAll()[0]!.status).toBe('disabled');
    warn.mockRestore();
  });
});

describe('renderer 接线', () => {
  it('scoped app 的 shell.exec / execStream 请求带上插件 id', async () => {
    const app = createScopedApp(createTestCoApp(), ID, null);
    await app.shell.exec('/bin/echo', ['hi']);
    expect(h.shellExec).toHaveBeenCalledWith(expect.objectContaining({ pluginId: ID }));

    const s = app.shell.execStream('/bin/echo', ['hi'], { timeoutMs: 1000 });
    await s.done;
    expect(h.execStream).toHaveBeenCalledWith('/bin/echo', ['hi'], {
      cwd: undefined,
      timeoutMs: 1000,
      pluginId: ID,
    });
  });

  it('未传 opts 的 execStream 也带上插件 id', async () => {
    const app = createScopedApp(createTestCoApp(), ID, null);
    await app.shell.execStream('/bin/echo', []).done;
    expect(h.execStream).toHaveBeenCalledWith('/bin/echo', [], { pluginId: ID });
  });

  it('createWindowApiHost.killPluginShellProcesses → coApi.shell.killPluginProcesses;ok:false 抛', async () => {
    const host = createWindowApiHost();
    await host.killPluginShellProcesses!(ID);
    expect(h.killPluginProcesses).toHaveBeenCalledWith(ID);
    h.killPluginProcesses.mockResolvedValue({ ok: false, code: 'DENIED', message: 'x' });
    await expect(host.killPluginShellProcesses!(ID)).rejects.toMatchObject({ code: 'DENIED' });
  });
});
