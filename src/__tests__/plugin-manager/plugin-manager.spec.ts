// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Plugin } from '../../plugins/Plugin';
import {
  PluginManager,
  type ManagerHost,
  type PluginDirInfo,
} from '../../plugins/PluginManager';
import { InMemoryPermissionStore } from '../../plugins/permissions';
import { createTestApp } from '../../plugins/test-utils';

const fakeApp = createTestApp('1.0.0');

// ── 测试夹具:可控的 ManagerHost mock ──────────────────

interface MockHostState {
  dirs: PluginDirInfo[];
  enabled: Set<string>;
  modules: Map<string, unknown>;
  enabledWritten: Set<string>;
}

function makeHost(state: MockHostState): ManagerHost {
  return {
    listPluginDirs: () => state.dirs,
    readEnabledIds: () => state.enabled,
    writeEnabledIds: (ids) => {
      state.enabledWritten = new Set(ids);
      state.enabled = new Set(ids);
    },
    importModule: async (url) => {
      const mod = state.modules.get(url);
      if (!mod) throw new Error(`module ${url} not registered`);
      return mod;
    },
  };
}

function manifestText(
  id: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    id,
    name: id,
    version: '0.1.0',
    ...extra,
  });
}

class GoodPlugin extends Plugin {
  static instances: GoodPlugin[] = [];
  static loaded: string[] = [];
  static unloaded: string[] = [];
  onload() {
    GoodPlugin.instances.push(this);
    GoodPlugin.loaded.push(this.manifest.id);
  }
  onunload() {
    GoodPlugin.unloaded.push(this.manifest.id);
  }
}

class FailingOnloadPlugin extends Plugin {
  onload() {
    throw new Error('boom in onload');
  }
}

beforeEach(() => {
  GoodPlugin.instances = [];
  GoodPlugin.loaded = [];
  GoodPlugin.unloaded = [];
});

// ── init:扫描 + 激活 ──────────────────────────────────

describe('init 扫描与激活', () => {
  it('enabled 插件被激活,disabled 被发现但不激活', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'a', manifestText: manifestText('a'), moduleUrl: 'mod://a' },
        { id: 'b', manifestText: manifestText('b'), moduleUrl: 'mod://b' },
      ],
      enabled: new Set(['a']),
      modules: new Map([
        ['mod://a', { default: GoodPlugin }],
        ['mod://b', { default: GoodPlugin }],
      ]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual(['a']);
    const list = mgr.listAll();
    expect(list.find((x) => x.id === 'a')?.status).toBe('enabled');
    expect(list.find((x) => x.id === 'b')?.status).toBe('disabled');
  });

  it('manifest 解析失败 → 跳过 + warn,不影响其它', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state: MockHostState = {
      dirs: [
        { id: 'bad', manifestText: 'not json {', moduleUrl: 'mod://bad' },
        { id: 'good', manifestText: manifestText('good'), moduleUrl: 'mod://good' },
      ],
      enabled: new Set(['bad', 'good']),
      modules: new Map([['mod://good', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual(['good']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('插件 onload 抛错 → 计入 failures,其它继续', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state: MockHostState = {
      dirs: [
        { id: 'fails', manifestText: manifestText('fails'), moduleUrl: 'mod://fails' },
        { id: 'ok', manifestText: manifestText('ok'), moduleUrl: 'mod://ok' },
      ],
      enabled: new Set(['fails', 'ok']),
      modules: new Map([
        ['mod://fails', { default: FailingOnloadPlugin }],
        ['mod://ok', { default: GoodPlugin }],
      ]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual(['ok']);
    const list = mgr.listAll();
    expect(list.find((x) => x.id === 'fails')?.status).toBe('failed');
    expect(list.find((x) => x.id === 'ok')?.status).toBe('enabled');
    warn.mockRestore();
  });

  it('minLMVersion 不兼容 → 跳过激活', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state: MockHostState = {
      dirs: [
        {
          id: 'newer',
          manifestText: manifestText('newer', { minLMVersion: '99.0.0' }),
          moduleUrl: 'mod://newer',
        },
      ],
      enabled: new Set(['newer']),
      modules: new Map([['mod://newer', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual([]);
    warn.mockRestore();
  });

  it('激活顺序按 dirs 顺序稳定', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'z', manifestText: manifestText('z'), moduleUrl: 'mod://z' },
        { id: 'a', manifestText: manifestText('a'), moduleUrl: 'mod://a' },
        { id: 'm', manifestText: manifestText('m'), moduleUrl: 'mod://m' },
      ],
      enabled: new Set(['z', 'a', 'm']),
      modules: new Map([
        ['mod://z', { default: GoodPlugin }],
        ['mod://a', { default: GoodPlugin }],
        ['mod://m', { default: GoodPlugin }],
      ]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual(['z', 'a', 'm']);
  });
});

// ── enable / disable ─────────────────────────────────

describe('enable / disable 动态', () => {
  it('disable 已激活插件 → 调 _deactivate + 写 enabled.json', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'a', manifestText: manifestText('a'), moduleUrl: 'mod://a' },
      ],
      enabled: new Set(['a']),
      modules: new Map([['mod://a', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    await mgr.disable('a');
    expect(GoodPlugin.unloaded).toEqual(['a']);
    expect([...state.enabledWritten]).toEqual([]);
    expect(mgr.listAll().find((x) => x.id === 'a')?.status).toBe('disabled');
  });

  it('enable disabled 插件 → load + activate + 写 enabled.json', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'a', manifestText: manifestText('a'), moduleUrl: 'mod://a' },
      ],
      enabled: new Set(),
      modules: new Map([['mod://a', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual([]);
    await mgr.enable('a');
    expect(GoodPlugin.loaded).toEqual(['a']);
    expect([...state.enabledWritten]).toEqual(['a']);
  });

  it('enable 不存在的 id → 抛错', async () => {
    const state: MockHostState = {
      dirs: [],
      enabled: new Set(),
      modules: new Map(),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    await expect(mgr.enable('nope')).rejects.toThrow(/not found/i);
  });

  it('重复 enable 已激活 → 幂等', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'a', manifestText: manifestText('a'), moduleUrl: 'mod://a' },
      ],
      enabled: new Set(['a']),
      modules: new Map([['mod://a', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual(['a']);
    await mgr.enable('a');
    expect(GoodPlugin.loaded).toEqual(['a']); // 不重复 load
  });
});

// ── shutdown ─────────────────────────────────────────

describe('shutdown', () => {
  it('LIFO 反序 _deactivate 全部 active', async () => {
    const state: MockHostState = {
      dirs: [
        { id: '1', manifestText: manifestText('1'), moduleUrl: 'mod://1' },
        { id: '2', manifestText: manifestText('2'), moduleUrl: 'mod://2' },
        { id: '3', manifestText: manifestText('3'), moduleUrl: 'mod://3' },
      ],
      enabled: new Set(['1', '2', '3']),
      modules: new Map([
        ['mod://1', { default: GoodPlugin }],
        ['mod://2', { default: GoodPlugin }],
        ['mod://3', { default: GoodPlugin }],
      ]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    await mgr.shutdown();
    expect(GoodPlugin.unloaded).toEqual(['3', '2', '1']);
  });
});

// ── v4.3 reload ────────────────────────────────────────

describe('reload(id)', () => {
  it('启用中插件 reload → _deactivate + 重 activate(用最新 mainText)', async () => {
    let mainText = 'old';
    class TrackPlugin extends Plugin {
      static loaded: string[] = [];
      static unloaded: string[] = [];
      onload() {
        TrackPlugin.loaded.push(`${this.manifest.id}:${mainText}`);
      }
      onunload() {
        TrackPlugin.unloaded.push(this.manifest.id);
      }
    }
    TrackPlugin.loaded = [];
    TrackPlugin.unloaded = [];

    const state: MockHostState = {
      dirs: [
        {
          id: 'r',
          manifestText: manifestText('r'),
          moduleUrl: 'mod://r',
        },
      ],
      enabled: new Set(['r']),
      modules: new Map([['mod://r', { default: TrackPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    expect(TrackPlugin.loaded).toEqual(['r:old']);

    // 模拟磁盘上的代码改了:更新 main text + 让 import 拿到新版本
    mainText = 'new';
    await mgr.reload('r');
    expect(TrackPlugin.unloaded).toEqual(['r']);
    expect(TrackPlugin.loaded).toEqual(['r:old', 'r:new']);
  });

  it('disabled 插件 reload → 仍 disabled,只换 dirInfo 不激活', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'd', manifestText: manifestText('d'), moduleUrl: 'mod://d' },
      ],
      enabled: new Set(),
      modules: new Map([['mod://d', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual([]);
    await mgr.reload('d');
    expect(GoodPlugin.loaded).toEqual([]); // 仍未激活
    expect(mgr.listAll().find((x) => x.id === 'd')?.status).toBe('disabled');
  });

  it('插件已从 plugins 目录移除 → 抛错', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'g', manifestText: manifestText('g'), moduleUrl: 'mod://g' },
      ],
      enabled: new Set(['g']),
      modules: new Map([['mod://g', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    state.dirs = []; // 模拟磁盘删了
    await expect(mgr.reload('g')).rejects.toThrow(/no longer exists/i);
  });

  it('不存在的 id → 抛错', async () => {
    const state: MockHostState = {
      dirs: [],
      enabled: new Set(),
      modules: new Map(),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    await expect(mgr.reload('nope')).rejects.toThrow(/not found/i);
  });

  it('reload 不变更 enabled.json', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'k', manifestText: manifestText('k'), moduleUrl: 'mod://k' },
      ],
      enabled: new Set(['k']),
      modules: new Map([['mod://k', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    state.enabledWritten = new Set();
    await mgr.reload('k');
    expect(state.enabledWritten.size).toBe(0);
  });
});

// ── v3.4 权限门 ────────────────────────────────────────

describe('权限门 ensureAuthorized 集成', () => {
  it('manifest 无 permissions → 不调 promptFn,直接激活', async () => {
    const promptFn = vi.fn();
    const state: MockHostState = {
      dirs: [
        { id: 'a', manifestText: manifestText('a'), moduleUrl: 'mod://a' },
      ],
      enabled: new Set(['a']),
      modules: new Map([['mod://a', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const host: ManagerHost = {
      ...makeHost(state),
      permissionStore: new InMemoryPermissionStore(),
      promptFn,
    };
    const mgr = new PluginManager(fakeApp, host);
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual(['a']);
    expect(promptFn).not.toHaveBeenCalled();
  });

  it('manifest 含 permissions + 用户全授 → 激活', async () => {
    const state: MockHostState = {
      dirs: [
        {
          id: 'a',
          manifestText: manifestText('a', { permissions: ['fs', 'network'] }),
          moduleUrl: 'mod://a',
        },
      ],
      enabled: new Set(['a']),
      modules: new Map([['mod://a', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const host: ManagerHost = {
      ...makeHost(state),
      permissionStore: new InMemoryPermissionStore(),
      promptFn: async (_pid, perms) => [...perms],
    };
    const mgr = new PluginManager(fakeApp, host);
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual(['a']);
  });

  it('manifest 含 permissions + 用户拒 → 标 failed,不激活', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state: MockHostState = {
      dirs: [
        {
          id: 'a',
          manifestText: manifestText('a', { permissions: ['fs', 'shell'] }),
          moduleUrl: 'mod://a',
        },
      ],
      enabled: new Set(['a']),
      modules: new Map([['mod://a', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const host: ManagerHost = {
      ...makeHost(state),
      permissionStore: new InMemoryPermissionStore(),
      promptFn: async () => [], // 全拒
    };
    const mgr = new PluginManager(fakeApp, host);
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual([]);
    const list = mgr.listAll();
    const entry = list.find((x) => x.id === 'a');
    expect(entry?.status).toBe('failed');
    expect(entry?.error).toContain('PERMISSION_DENIED');
    warn.mockRestore();
  });

  it('host 不配 permissionStore → 跳过权限门(向后兼容)', async () => {
    const state: MockHostState = {
      dirs: [
        {
          id: 'a',
          manifestText: manifestText('a', { permissions: ['fs'] }),
          moduleUrl: 'mod://a',
        },
      ],
      enabled: new Set(['a']),
      modules: new Map([['mod://a', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    // 没 permissionStore,直接激活,即便 manifest 声明了权限
    expect(GoodPlugin.loaded).toEqual(['a']);
  });
});
