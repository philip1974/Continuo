// @vitest-environment jsdom
// race(R29):停用插件时 _unregisterPlugin(plugin-fs capability token 回收)若 IPC reject,
// 不得半提交 —— 此前 revokePluginFsToken「先清 entry.pluginFsToken 再 await unregister」,reject 时:
//   1. 本地丢 token,而 main 侧 token 可能仍有效 → 不可回收的 capability 泄漏;
//   2. 异常上抛使 deactivateEntry 的 finally 半提交(instance 已清、status 没落 'disabled'),
//      后续 disableLocked 的 `!entry.instance` 守卫早退 → 无法重试回收、状态卡死。
// 修:仅 unregister 成功才清 token;失败保留 token + 不抛(本地拆除照常完成 status='disabled'),
// 并在下次 activateEntry 注册新 token 前 flush 残留旧 token(重试回收)。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const coApiMocks = vi.hoisted(() => ({
  pluginFsRaw: {
    _registerPlugin: vi.fn().mockResolvedValue({ token: 'tok1', generation: 1 }),
    _unregisterPlugin: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/co-api', () => ({
  coApi: { pluginFsRaw: coApiMocks.pluginFsRaw },
}));

import { Plugin } from '../../plugins/Plugin';
import {
  PluginManager,
  type ManagerHost,
  type PluginDirInfo,
} from '../../plugins/PluginManager';
import { createTestCoApp } from '../../plugins/test-utils';

const fakeApp = createTestCoApp('1.0.0');

class OkPlugin extends Plugin {
  onload(): void {}
}

function manifestText(id: string): string {
  return JSON.stringify({ id, name: id, version: '0.1.0' });
}

function makeHost(
  modules: Map<string, unknown>,
  dirs: PluginDirInfo[],
  enabled: Set<string>,
): ManagerHost {
  return {
    listPluginDirs: () => dirs,
    readEnabledIds: () => enabled,
    mutateEnabledId: (id, on) => {
      if (on) enabled.add(id);
      else enabled.delete(id);
    },
    importModule: async (url) => {
      const mod = modules.get(url);
      if (!mod) throw new Error(`module ${url} not registered`);
      return mod;
    },
    removePluginDir: async () => {},
  };
}

function makeMgr(removePluginDir?: ManagerHost['removePluginDir']) {
  const dirs: PluginDirInfo[] = [
    { id: 'p', manifestText: manifestText('p'), moduleUrl: 'mod://p' },
  ];
  const modules = new Map<string, unknown>([['mod://p', { default: OkPlugin }]]);
  const host = makeHost(modules, dirs, new Set(['p']));
  return new PluginManager(
    fakeApp,
    removePluginDir ? { ...host, removePluginDir } : host,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  coApiMocks.pluginFsRaw._registerPlugin.mockResolvedValue({ token: 'tok1', generation: 1 });
  coApiMocks.pluginFsRaw._unregisterPlugin.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('race(R29) · plugin-fs token 回收失败不半提交 + 可重试', () => {
  it('disable 时 _unregisterPlugin reject → 不抛 + status=disabled(不卡 enabled)', async () => {
    const mgr = makeMgr();
    await mgr.init(); // activate → 注册 tok1
    expect(coApiMocks.pluginFsRaw._registerPlugin).toHaveBeenCalledWith('p');

    coApiMocks.pluginFsRaw._unregisterPlugin.mockRejectedValueOnce(new Error('ipc down'));
    // 不抛(本地拆除照常完成)。
    await expect(mgr.disable('p')).resolves.toBeUndefined();
    // 状态正常落到 disabled —— 不是卡在 'enabled' 的半提交僵尸态。
    expect(mgr.listAll().find((x) => x.id === 'p')?.status).toBe('disabled');
    // 确实尝试过用 tok1 回收。
    expect(coApiMocks.pluginFsRaw._unregisterPlugin).toHaveBeenCalledWith('tok1');
  });

  it('回收失败后保留 token → 再启用时先重试回收旧 token(tok1)再注册新 token', async () => {
    const mgr = makeMgr();
    await mgr.init(); // 注册 tok1

    coApiMocks.pluginFsRaw._unregisterPlugin.mockRejectedValueOnce(new Error('ipc down'));
    await mgr.disable('p'); // tok1 回收失败 → 保留

    coApiMocks.pluginFsRaw._unregisterPlugin.mockClear();
    coApiMocks.pluginFsRaw._unregisterPlugin.mockResolvedValue(undefined); // 这次回收成功
    coApiMocks.pluginFsRaw._registerPlugin.mockResolvedValueOnce({ token: 'tok2', generation: 2 });

    await mgr.enable('p'); // activateEntry:先 flush 残留 tok1(重试),再注册 tok2

    // 证明 token 被保留:再启用时用旧 tok1 重试回收(若 bug 丢了 token,这里不会再调用)。
    expect(coApiMocks.pluginFsRaw._unregisterPlugin).toHaveBeenCalledWith('tok1');
    expect(coApiMocks.pluginFsRaw._registerPlugin).toHaveBeenCalledWith('p');
    expect(mgr.listAll().find((x) => x.id === 'p')?.status).toBe('enabled');
  });

  it('正常 disable(_unregisterPlugin 成功)→ 再启用不重复回收旧 token(成功即清)', async () => {
    const mgr = makeMgr();
    await mgr.init(); // 注册 tok1
    await mgr.disable('p'); // tok1 回收成功 → 清空

    coApiMocks.pluginFsRaw._unregisterPlugin.mockClear();
    coApiMocks.pluginFsRaw._registerPlugin.mockResolvedValueOnce({ token: 'tok2', generation: 2 });
    await mgr.enable('p'); // flush 时无残留 token → 不调用 unregister

    expect(coApiMocks.pluginFsRaw._unregisterPlugin).not.toHaveBeenCalled();
    expect(mgr.listAll().find((x) => x.id === 'p')?.status).toBe('enabled');
  });
});

// 卸载路径同样须回收保留的 token:此前 uninstallLocked 对已 disabled(含回收失败保留 token)的
// 插件直接删目录 + entries.delete(id) → token 引用丢失,主进程 IdentityRegistry 里仍 active、
// path scope 未撤销 = 不可回收的 capability 泄漏。修:卸载前对残留 token 重试回收;仍失败 →
// 卸载失败(不删目录、保留 entry),可再次重试。
describe('uninstall · 回收保留的 plugin-fs token', () => {
  it('disable 回收失败保留 token → uninstall 先重试回收 tok1 再删目录', async () => {
    const removePluginDir = vi.fn(async () => {});
    const mgr = makeMgr(removePluginDir);
    await mgr.init(); // 注册 tok1
    coApiMocks.pluginFsRaw._unregisterPlugin.mockRejectedValueOnce(new Error('ipc down'));
    await mgr.disable('p'); // tok1 回收失败 → 保留

    coApiMocks.pluginFsRaw._unregisterPlugin.mockClear();
    await mgr.uninstall('p');

    expect(coApiMocks.pluginFsRaw._unregisterPlugin).toHaveBeenCalledWith('tok1');
    expect(removePluginDir).toHaveBeenCalledWith('p');
    expect(mgr.listAll().find((x) => x.id === 'p')).toBeUndefined();
  });

  it('uninstall 时重试回收仍失败 → 卸载失败(不删目录、保留 entry),之后可重试成功', async () => {
    const removePluginDir = vi.fn(async () => {});
    const mgr = makeMgr(removePluginDir);
    await mgr.init();
    coApiMocks.pluginFsRaw._unregisterPlugin.mockRejectedValueOnce(new Error('ipc down'));
    await mgr.disable('p');

    coApiMocks.pluginFsRaw._unregisterPlugin.mockRejectedValueOnce(new Error('ipc down'));
    await expect(mgr.uninstall('p')).rejects.toMatchObject({
      code: 'PLUGIN_FS_TOKEN_REVOKE_FAILED',
    });
    expect(removePluginDir).not.toHaveBeenCalled();
    expect(mgr.listAll().find((x) => x.id === 'p')?.status).toBe('disabled');

    // 重试:这次回收成功 → 卸载完成。
    coApiMocks.pluginFsRaw._unregisterPlugin.mockClear();
    await mgr.uninstall('p');
    expect(coApiMocks.pluginFsRaw._unregisterPlugin).toHaveBeenCalledWith('tok1');
    expect(removePluginDir).toHaveBeenCalledWith('p');
    expect(mgr.listAll().find((x) => x.id === 'p')).toBeUndefined();
  });
});

// 再启用时重试回收残留 token 仍失败:此前照常注册新 token 并覆盖 entry.pluginFsToken → 旧 token
// 在主进程仍 active、path scope 未撤销,且本地永久失去引用。修:中止本次激活(不加载插件、不注册
// 新 token、不进 enabled、报 PLUGIN_FS_TOKEN_REVOKE_FAILED),残留 token 保留,下次启用再重试。
describe('enable · 残留 token 重试回收仍失败 → 中止激活', () => {
  it('不注册新 token、状态 failed + 错误码,残留 tok1 保留;之后回收成功即可正常启用', async () => {
    const mgr = makeMgr();
    await mgr.init(); // 注册 tok1
    coApiMocks.pluginFsRaw._unregisterPlugin.mockRejectedValueOnce(new Error('ipc down'));
    await mgr.disable('p'); // tok1 回收失败 → 保留

    coApiMocks.pluginFsRaw._registerPlugin.mockClear();
    coApiMocks.pluginFsRaw._unregisterPlugin.mockReset();
    coApiMocks.pluginFsRaw._unregisterPlugin.mockRejectedValue(new Error('ipc down'));
    await mgr.enable('p');

    expect(coApiMocks.pluginFsRaw._registerPlugin).not.toHaveBeenCalled();
    const row = mgr.listAll().find((x) => x.id === 'p');
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBe('PLUGIN_FS_TOKEN_REVOKE_FAILED');

    // 恢复后重试:先用保留的 tok1 回收,再注册新 token、正常启用。
    coApiMocks.pluginFsRaw._unregisterPlugin.mockReset();
    coApiMocks.pluginFsRaw._unregisterPlugin.mockResolvedValue(undefined);
    coApiMocks.pluginFsRaw._registerPlugin.mockResolvedValueOnce({ token: 'tok2', generation: 2 });
    await mgr.enable('p');
    expect(coApiMocks.pluginFsRaw._unregisterPlugin).toHaveBeenCalledWith('tok1');
    expect(coApiMocks.pluginFsRaw._registerPlugin).toHaveBeenCalledWith('p');
    expect(mgr.listAll().find((x) => x.id === 'p')?.status).toBe('enabled');
  });
});
