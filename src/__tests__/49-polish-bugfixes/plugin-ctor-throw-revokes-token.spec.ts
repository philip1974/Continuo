// @vitest-environment jsdom
// topic 49 第十二 session · codex 复审 loop R1:插件构造器同步抛错必须回收 plugin-fs token。
//
// 根因:activateEntry 先 `_registerPlugin` 把 entry.pluginFsToken 设 active,然后在
// `_activate()` 的 try/catch **之外** `new Ctor(scopedApp, manifest)`。若插件构造器同步
// 抛错,直接跳出 activateEntry → 不走 revokePluginFsToken、不标 failed → entry 停在
// status='enabled' 但 instance=undefined 的半激活态。后续 disableLocked 的 `!entry.instance`
// 守卫又会早退、不 deactivateEntry → 泄漏的 capability token 永不回收(若构造器抛错前保留了
// scopedApp / 启动了异步任务,仍可能继续用已授权能力)。
//
// 修:把 `new Ctor()` 纳入与 `_activate()` 同一 try/catch → 构造器抛错也设 status='failed'、
// 记 error、await revokePluginFsToken。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const coApiMocks = vi.hoisted(() => ({
  pluginFsRaw: {
    _registerPlugin: vi.fn().mockResolvedValue({ token: 'test-token', generation: 1 }),
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

class FailingCtorPlugin extends Plugin {
  constructor(app: ConstructorParameters<typeof Plugin>[0], manifest: ConstructorParameters<typeof Plugin>[1]) {
    super(app, manifest);
    throw new Error('boom in constructor');
  }
  onload(): void {}
}

function manifestText(id: string): string {
  return JSON.stringify({ id, name: id, version: '0.1.0' });
}

function makeHost(modules: Map<string, unknown>, dirs: PluginDirInfo[], enabled: Set<string>): ManagerHost {
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

beforeEach(() => {
  vi.clearAllMocks();
  coApiMocks.pluginFsRaw._registerPlugin.mockResolvedValue({ token: 'test-token', generation: 1 });
  coApiMocks.pluginFsRaw._unregisterPlugin.mockResolvedValue(undefined);
});

describe('topic49 codex-loop R1 · 构造器抛错回收 plugin-fs token', () => {
  it('插件构造器同步抛错 → token 被回收 + status=failed,不留半激活态', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dirs: PluginDirInfo[] = [
      { id: 'boom', manifestText: manifestText('boom'), moduleUrl: 'mod://boom' },
    ];
    const modules = new Map<string, unknown>([['mod://boom', { default: FailingCtorPlugin }]]);
    const mgr = new PluginManager(fakeApp, makeHost(modules, dirs, new Set(['boom'])));

    await mgr.init();

    // token 注册过 → 必须回收
    expect(coApiMocks.pluginFsRaw._registerPlugin).toHaveBeenCalledWith('boom');
    expect(coApiMocks.pluginFsRaw._unregisterPlugin).toHaveBeenCalledWith('test-token');

    // 不留「enabled 但无实例」的半激活僵尸态:状态必须是 failed(bug 会留 'enabled')。
    // (listAll() 返回脱敏的 PluginListItem,不暴露 instance;status 已足证非僵尸态)
    const entry = mgr.listAll().find((x) => x.id === 'boom');
    expect(entry?.status).toBe('failed');
  });

  it('随后 disable 不再泄漏(token 已回收,无二次 unregister 错配)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dirs: PluginDirInfo[] = [
      { id: 'boom', manifestText: manifestText('boom'), moduleUrl: 'mod://boom' },
    ];
    const modules = new Map<string, unknown>([['mod://boom', { default: FailingCtorPlugin }]]);
    const mgr = new PluginManager(fakeApp, makeHost(modules, dirs, new Set(['boom'])));
    await mgr.init();
    coApiMocks.pluginFsRaw._unregisterPlugin.mockClear();

    // failed 插件 disable 应是幂等 no-op(token 早已在激活失败时回收)
    await mgr.disable('boom');
    expect(coApiMocks.pluginFsRaw._unregisterPlugin).not.toHaveBeenCalled();
  });
});
