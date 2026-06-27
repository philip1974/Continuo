// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const coApiMocks = vi.hoisted(() => ({
  pluginFsRaw: {
    _registerPlugin: vi.fn().mockResolvedValue({
      token: 'test-token',
      generation: 1,
    }),
    _unregisterPlugin: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('mock content'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({
      size: 0,
      mtimeMs: 0,
      isFile: true,
      isDirectory: false,
      isSymlink: false,
    }),
    lstat: vi.fn().mockResolvedValue({
      size: 0,
      mtimeMs: 0,
      isFile: true,
      isDirectory: false,
      isSymlink: false,
    }),
    realpath: vi.fn(async (p: string) => p),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    cp: vi.fn().mockResolvedValue(undefined),
    readGitBlob: vi.fn().mockResolvedValue(new Uint8Array()),
    atomicReplaceWithinScope: vi.fn().mockResolvedValue(undefined),
    requestScope: vi.fn().mockResolvedValue('grant'),
    _scopeDecision: vi.fn().mockResolvedValue(undefined),
    onScopeRequest: vi.fn(() => () => {}),
    onScopeUpdated: vi.fn(() => () => {}),
  },
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: coApiMocks.pluginFsRaw,
  },
}));

import { Plugin } from '../../plugins/Plugin';
import {
  PluginManager,
  type ManagerHost,
  type PluginDirInfo,
} from '../../plugins/PluginManager';
import { InMemoryPermissionStore } from '../../plugins/permissions';
import { createTestCoApp } from '../../plugins/test-utils';

const fakeApp = createTestCoApp('1.0.0');

// ── 测试夹具:可控的 ManagerHost mock ──────────────────

interface MockHostState {
  dirs: PluginDirInfo[];
  enabled: Set<string>;
  modules: Map<string, unknown>;
  enabledWritten: Set<string>;
  /** v4.6 卸载:记下被请求删的 id;调用方决定要不要从 dirs 同步删. */
  removed?: string[];
}

function makeHost(state: MockHostState): ManagerHost {
  return {
    listPluginDirs: () => state.dirs,
    readEnabledIds: () => state.enabled,
    // 数据安全:enable/disable 走 main 端 delta 写(mutateEnabledId),mock 在内存里做
    // 同样的 read-modify-write(对 state.enabled 加/删 id),复现主进程 setEnabledId 行为。
    mutateEnabledId: (id, enabled) => {
      const next = new Set(state.enabled);
      if (enabled) next.add(id);
      else next.delete(id);
      state.enabled = next;
      state.enabledWritten = next;
    },
    importModule: async (url) => {
      const mod = state.modules.get(url);
      if (!mod) throw new Error(`module ${url} not registered`);
      return mod;
    },
    removePluginDir: async (id) => {
      (state.removed ??= []).push(id);
      state.dirs = state.dirs.filter((d) => d.id !== id);
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
  vi.clearAllMocks();
  coApiMocks.pluginFsRaw._registerPlugin.mockResolvedValue({
    token: 'test-token',
    generation: 1,
  });
  coApiMocks.pluginFsRaw._unregisterPlugin.mockResolvedValue(undefined);
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

  it('listAll 构造快照时不通过 Array.from(values).map 生成中间数组', async () => {
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

    const arrayFromSpy = vi.spyOn(Array, 'from');
    let list: ReturnType<PluginManager['listAll']>;
    try {
      list = mgr.listAll();
      expect(arrayFromSpy).not.toHaveBeenCalled();
    } finally {
      arrayFromSpy.mockRestore();
    }
    expect(list!.map((x) => x.id)).toEqual(['a', 'b']);
    expect(list!.find((x) => x.id === 'a')?.status).toBe('enabled');
    expect(list!.find((x) => x.id === 'b')?.status).toBe('disabled');
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

  // race(R101):生命周期串行链(withLifecycleLock→runSerialPerKey)排空后必须删除 lifecycleLocks
  // 条目,否则 Map 随操作过的不同插件 id 单调增长 = 内存泄漏。
  it('生命周期链排空后回收 lifecycleLocks 条目(不随 id 单调增长)', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'a', manifestText: manifestText('a'), moduleUrl: 'mod://a' },
        { id: 'b', manifestText: manifestText('b'), moduleUrl: 'mod://b' },
      ],
      enabled: new Set(),
      modules: new Map([
        ['mod://a', { default: GoodPlugin }],
        ['mod://b', { default: GoodPlugin }],
      ]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    const locks = (mgr as unknown as { lifecycleLocks: Map<string, unknown> })
      .lifecycleLocks;
    await mgr.enable('a');
    await mgr.enable('b');
    await Promise.resolve(); // cleanup 微任务
    expect(locks.size).toBe(0); // 两 id 链排空后全回收
  });

  // 数据安全(codex 复查 P1):_enabled.json 读失败(IO 错误)时 host.readEnabledIds 现传播
  // 异常。init 须降级(不崩、不激活、不写),避免启动因一次读错误崩溃。
  it('host.readEnabledIds 读失败 → init 降级不崩(不激活、不写)', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'a', manifestText: manifestText('a'), moduleUrl: 'mod://a' },
      ],
      enabled: new Set(),
      modules: new Map([['mod://a', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const failingHost: ManagerHost = {
      ...makeHost(state),
      readEnabledIds: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    };
    const mgr = new PluginManager(fakeApp, failingHost);

    // init 读失败 → 降级,不抛、不激活任何插件
    await expect(mgr.init()).resolves.toBeUndefined();
    expect(GoodPlugin.loaded).toEqual([]);
  });

  // 数据安全(codex 复查 P1/P2):enable/disable 走 main 端 delta 写(host.mutateEnabledId)。
  // 主进程 setEnabledId 在串行链内 RMW;读/写失败时 mutateEnabledId reject → enable 须 reject
  // (失败可见),不再静默 resolve 让用户以为已切换但盘未写。跨窗口无 lost update 的串行性由
  // 主进程 setEnabledId 测试覆盖(见 electron/main/__tests__/plugins-enabled-mutate.test.ts)。
  it('host.mutateEnabledId 持久化失败 → enable 抛(不静默报成功)', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'a', manifestText: manifestText('a'), moduleUrl: 'mod://a' },
      ],
      enabled: new Set(),
      modules: new Map([['mod://a', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const failingHost: ManagerHost = {
      ...makeHost(state),
      mutateEnabledId: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    };
    const mgr = new PluginManager(fakeApp, failingHost);
    await mgr.init();
    await expect(mgr.enable('a')).rejects.toThrow();
  });

  it('并发 enable 不同插件 → 都经 delta 写落盘启用(renderer 转发两个 delta)', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'a', manifestText: manifestText('a'), moduleUrl: 'mod://a' },
        { id: 'b', manifestText: manifestText('b'), moduleUrl: 'mod://b' },
      ],
      enabled: new Set(),
      modules: new Map([
        ['mod://a', { default: GoodPlugin }],
        ['mod://b', { default: GoodPlugin }],
      ]),
      enabledWritten: new Set(),
    };
    // renderer 不再整表 RMW,只对每个 id 发 mutateEnabledId(id, true) delta;两个 delta
    // 各自应用,无相互覆盖。跨窗口竞态(两个 PluginManager 各自 RMW)的真正修复在主进程
    // setEnabledId 串行链,由 plugins-enabled-mutate.test.ts 覆盖。
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();

    await Promise.all([mgr.enable('a'), mgr.enable('b')]);

    expect([...state.enabled].sort()).toEqual(['a', 'b']);
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

  // race(R77):reload 据「用户启用意图」而非瞬时 status 判重激活。连续热重载中先读到坏
  // manifest 把已启用插件置 'failed',文件修好再 reload 时不能因 status 非 'enabled' 就停用。
  it('R77 reload 遇瞬时坏 manifest 置 failed,修好后再 reload 仍按启用意图重激活', async () => {
    const state: MockHostState = {
      dirs: [{ id: 'r', manifestText: manifestText('r'), moduleUrl: 'mod://r' }],
      enabled: new Set(['r']),
      modules: new Map([['mod://r', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    expect(mgr.listAll().find((x) => x.id === 'r')?.status).toBe('enabled');

    // 1) 热重载读到半写入 manifest:JSON 合法、id 对(故 reload 能 find 到),但缺 name/version
    // → parseManifest 失败 → 已启用插件被置 'failed'(先 deactivate)。
    state.dirs[0]!.manifestText = JSON.stringify({ id: 'r' });
    await mgr.reload('r');
    expect(mgr.listAll().find((x) => x.id === 'r')?.status).toBe('failed');

    // 2) 文件修好再次 reload → 按用户启用意图重激活,而非因瞬时坏快照推断成 disabled。
    state.dirs[0]!.manifestText = manifestText('r');
    await mgr.reload('r');
    expect(mgr.listAll().find((x) => x.id === 'r')?.status).toBe('enabled');
  });

  it('并发 reload 同 id → 串行,不泄漏 fs token、不留僵尸实例(topic49 第九轮 P1-Y)', async () => {
    // 根因:enable/disable/reload 无 per-id 锁。reload 由 mtime watcher 每 2s
    // fire-and-forget + 用户操作易并发同 id。旧实现两次 reload 交错时,先发的
    // activateEntry resume 后用旧 token 覆盖 entry.pluginFsToken → 新 token 永不
    // _unregisterPlugin(泄漏)+ 留双激活僵尸实例。加 withLifecycleLock 串行化后,
    // register/unregister 与 onload/onunload 必须配平(只余最后一个活实例)。
    const state: MockHostState = {
      dirs: [{ id: 'c', manifestText: manifestText('c'), moduleUrl: 'mod://c' }],
      enabled: new Set(['c']),
      modules: new Map([['mod://c', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual(['c']); // init 激活一次

    // 同时打两发 reload(模拟 watcher + 用户操作并发命中同 id)
    await Promise.all([mgr.reload('c'), mgr.reload('c')]);

    const regs = coApiMocks.pluginFsRaw._registerPlugin.mock.calls.length;
    const unregs = coApiMocks.pluginFsRaw._unregisterPlugin.mock.calls.length;
    // 恰好一个活实例:每次 (de)activate 配平,无 token 泄漏
    expect(regs - unregs).toBe(1);
    // 实例配平:无僵尸(每个 onload 都有对应 onunload,除最后一个活实例)
    expect(GoodPlugin.loaded.length - GoodPlugin.unloaded.length).toBe(1);
    // 最终仍 enabled 且只剩一个活实例
    expect(mgr.listAll().find((x) => x.id === 'c')?.status).toBe('enabled');
  });

  it('init 激活挂起期间并发 reload 同 id → 串行不泄漏 token(第十一轮:init 也走锁)', async () => {
    // 根因:init() 的激活循环旧实现直接调 activateEntry **不走** withLifecycleLock,
    // 而 activateEntry 在 ensureAuthorized/importModule 处 await(权限弹窗可挂数秒)。
    // main-app 紧接 void init() 就接线 mtime watcher 的 onChanged→reload(走锁)。
    // 激活挂起期间被改动文件触发的 reload 拿到空锁并发执行 → 与 reload P1-Y 同源的
    // token 泄漏/双激活。把 init 的 activateEntry 也包进锁后,两者串行、配平。
    let releaseImport!: () => void;
    const gate = new Promise<void>((res) => {
      releaseImport = res;
    });
    let firstImport = true;
    const state: MockHostState = {
      dirs: [{ id: 'c', manifestText: manifestText('c'), moduleUrl: 'mod://c' }],
      enabled: new Set(['c']),
      modules: new Map([['mod://c', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const host = makeHost(state);
    const baseImport = host.importModule;
    host.importModule = async (url: string) => {
      if (firstImport) {
        firstImport = false;
        await gate; // 暂停 init 的 activateEntry,模拟权限弹窗挂起
      }
      return baseImport(url);
    };
    const mgr = new PluginManager(fakeApp, host);

    const initP = mgr.init();
    // 等 init 进入 activateEntry 的 importModule await(firstImport 翻 false)
    await vi.waitFor(() => expect(firstImport).toBe(false));
    // 此刻 init 激活挂起 → mtime watcher 触发同 id reload
    const reloadP = mgr.reload('c');
    releaseImport();
    await Promise.all([initP, reloadP]);

    const regs = coApiMocks.pluginFsRaw._registerPlugin.mock.calls.length;
    const unregs = coApiMocks.pluginFsRaw._unregisterPlugin.mock.calls.length;
    expect(regs - unregs).toBe(1); // 无 token 泄漏
    expect(GoodPlugin.loaded.length - GoodPlugin.unloaded.length).toBe(1); // 无僵尸
    expect(mgr.listAll().find((x) => x.id === 'c')?.status).toBe('enabled');
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

// ── v4.6 uninstall ─────────────────────────────────────

describe('uninstall(id)', () => {
  it('启用中插件 uninstall → 先 _deactivate 再删目录,从 listAll 消失', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'u', manifestText: manifestText('u'), moduleUrl: 'mod://u' },
      ],
      enabled: new Set(['u']),
      modules: new Map([['mod://u', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual(['u']);

    await mgr.uninstall('u');

    expect(GoodPlugin.unloaded).toEqual(['u']);
    expect(state.removed).toEqual(['u']);
    expect(mgr.listAll().find((x) => x.id === 'u')).toBeUndefined();
    expect([...state.enabledWritten]).toEqual([]); // disable 已写空
  });

  it('disabled 插件 uninstall → 直接删,不调 _deactivate', async () => {
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
    await mgr.uninstall('d');
    expect(GoodPlugin.unloaded).toEqual([]);
    expect(state.removed).toEqual(['d']);
    expect(mgr.listAll()).toEqual([]);
  });

  it('不存在的 id → 抛错,不调 removePluginDir', async () => {
    const state: MockHostState = {
      dirs: [],
      enabled: new Set(),
      modules: new Map(),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    await expect(mgr.uninstall('nope')).rejects.toThrow(/not found/i);
    expect(state.removed).toBeUndefined();
  });

  it('host 未实现 removePluginDir → 抛 NOT_SUPPORTED', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'x', manifestText: manifestText('x'), moduleUrl: 'mod://x' },
      ],
      enabled: new Set(),
      modules: new Map([['mod://x', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const baseHost = makeHost(state);
    const host: ManagerHost = {
      listPluginDirs: baseHost.listPluginDirs,
      readEnabledIds: baseHost.readEnabledIds,
      mutateEnabledId: baseHost.mutateEnabledId,
      importModule: baseHost.importModule,
      // intentionally omit removePluginDir
    };
    const mgr = new PluginManager(fakeApp, host);
    await mgr.init();
    await expect(mgr.uninstall('x')).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    });
  });

  it('uninstall 后再 enable 同 id → 抛 not found(entries 已删)', async () => {
    const state: MockHostState = {
      dirs: [
        { id: 'g', manifestText: manifestText('g'), moduleUrl: 'mod://g' },
      ],
      enabled: new Set(),
      modules: new Map([['mod://g', { default: GoodPlugin }]]),
      enabledWritten: new Set(),
    };
    const mgr = new PluginManager(fakeApp, makeHost(state));
    await mgr.init();
    await mgr.uninstall('g');
    await expect(mgr.enable('g')).rejects.toThrow(/not found/i);
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

  it('manifest 含 permissions + 用户全拒 → 标 failed,不激活', async () => {
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
    // i18n(I4):error 改结构化 {code, message}
    expect(entry?.error?.code).toBe('PERMISSION_DENIED');
    warn.mockRestore();
  });

  it('v5 partial grant:用户授部分 → status=enabled + entry.warning,plugin 仍激活', async () => {
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
      promptFn: async () => ['fs'] as never, // 只授 fs
    };
    const mgr = new PluginManager(fakeApp, host);
    await mgr.init();
    expect(GoodPlugin.loaded).toEqual(['a']); // 仍激活
    const item = mgr.listAll()[0]!;
    expect(item.status).toBe('enabled');
    // i18n(I3):warning 改结构化 {code, params},manager 不再拼可见文本(renderer 经
    // catalog 渲染,避免中文泄漏到 en/ko 且随 locale 响应)。
    expect(item.warning?.code).toBe('plugins_tab.warning.partial_grant');
    expect(item.warning?.params?.granted).toBe('fs'); // 只授 fs
    expect(item.warning?.params?.denied).toBe('network'); // 未授 network
    expect(item.error).toBeUndefined();
  });

  it('v5 partial grant 后用户改主意全授 → reload 时 warning 清空', async () => {
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
    const store = new InMemoryPermissionStore();
    let calls = 0;
    const host: ManagerHost = {
      ...makeHost(state),
      permissionStore: store,
      // 第一次只授 fs(partial),后续 store 已有完整决策不会再 prompt
      promptFn: async () => {
        calls += 1;
        return calls === 1 ? (['fs'] as never) : ([] as never);
      },
    };
    const mgr = new PluginManager(fakeApp, host);
    await mgr.init();
    expect(mgr.listAll()[0]?.warning?.code).toBe(
      'plugins_tab.warning.partial_grant',
    );

    // 模拟用户在 PermissionEditorModal 改:授 network(已有 fs grant 不动,deny 翻 grant)
    await store.grant('a', ['network']);

    // reload 让权限重检
    await mgr.reload('a');
    expect(mgr.listAll()[0]?.warning).toBeUndefined();
    expect(mgr.listAll()[0]?.status).toBe('enabled');
  });

  it('FAILED 重试 enable 成功 → entry.error 清空(不再渲染遗留红字)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    let promptCalls = 0;
    const promptFn = vi.fn(async (_pid: string, perms: readonly string[]) => {
      promptCalls += 1;
      return promptCalls === 1 ? [] : [...perms];
    });
    const host: ManagerHost = {
      ...makeHost(state),
      permissionStore: new InMemoryPermissionStore(),
      promptFn: promptFn as never,
    };
    const mgr = new PluginManager(fakeApp, host);
    await mgr.init();
    // i18n(I4):error 改结构化 {code, message}
    expect(mgr.listAll()[0]?.error?.code).toBe('PERMISSION_DENIED');

    await mgr.enable('a');
    expect(mgr.listAll()[0]?.status).toBe('enabled');
    expect(mgr.listAll()[0]?.error).toBeUndefined();
    warn.mockRestore();
  });

  it('FAILED 重试 enable → 清掉旧 deny 重新 prompt(用户改主意)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    let promptCalls = 0;
    const promptFn = vi.fn(async (_pid: string, perms: readonly string[]) => {
      promptCalls += 1;
      // 第一次拒,第二次授
      return promptCalls === 1 ? [] : [...perms];
    });
    const host: ManagerHost = {
      ...makeHost(state),
      permissionStore: new InMemoryPermissionStore(),
      promptFn: promptFn as never,
    };
    const mgr = new PluginManager(fakeApp, host);
    await mgr.init();
    expect(mgr.listAll()[0]?.status).toBe('failed');

    await mgr.enable('a');
    expect(promptCalls).toBe(2); // 重试时再 prompt 一次
    expect(GoodPlugin.loaded).toEqual(['a']);
    expect(mgr.listAll()[0]?.status).toBe('enabled');
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
