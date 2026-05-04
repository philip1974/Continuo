// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Plugin } from '../../plugins/Plugin';
import {
  PluginManager,
  type ManagerHost,
  type PluginDirInfo,
} from '../../plugins/PluginManager';
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
