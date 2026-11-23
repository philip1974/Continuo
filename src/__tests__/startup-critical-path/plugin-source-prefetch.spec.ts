// @vitest-environment jsdom
// perf(B-1):启动时插件源码预取。PluginManager.init 两阶段之间对已启用插件有界并发(4)预取源码
//(readMainByDir → Blob URL,不 import、不执行插件代码),串行激活命中预取;激活顺序不变。
// 真实 createWindowApiHost + PluginManager,coApi 由 window.api 注入;jsdom 无法 import blob: URL,
// 故 importModule 先跑真实 host 的解析链路(拉取 / 命中预取 / revoke),再返回测试插件类。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { createWindowApiHost } from '../../lib/plugins-host';
import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost } from '../../plugins/PluginManager';
import { createTestCoApp } from '../../plugins/test-utils';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const loaded: string[] = [];
const hang = new Map<string, Deferred<void>>();

class TestPlugin extends Plugin {
  onload(): Promise<void> | void {
    loaded.push(this.manifest.id);
    return hang.get(this.manifest.id)?.promise;
  }
}

const manifest = (id: string, version = '0.1.0') => JSON.stringify({ id, name: id, version });

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let blobSeq = 0;

function setup(opts: {
  ids: string[];
  enabled: string[];
  readMainByDir: (dir: string, hash: string) => Promise<unknown>;
  readDirById?: (id: string) => Promise<unknown>;
}) {
  const plugins = {
    listDirs: vi.fn().mockResolvedValue({
      ok: true,
      data: opts.ids.map((id) => ({ id, manifestText: manifest(id), manifestHash: `hash-${id}` })),
    }),
    readEnabled: vi.fn().mockResolvedValue({ ok: true, data: opts.enabled }),
    mutateEnabled: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    readMainByDir: vi.fn(opts.readMainByDir),
    readDirById: vi.fn(opts.readDirById ?? (async () => ({ ok: true, data: null }))),
  };
  Object.defineProperty(window, 'api', {
    value: {
      plugins,
      pluginFsRaw: {
        _registerPlugin: vi.fn().mockResolvedValue({ token: 'tok' }),
        _unregisterPlugin: vi.fn().mockResolvedValue(undefined),
      },
      shell: { killPluginProcesses: vi.fn().mockResolvedValue({ ok: true, data: undefined }) },
    },
    writable: true,
    configurable: true,
  });
  captureLmApi();
  const real = createWindowApiHost();
  /** 每次 import 实际用到的可 import URL(解析后的 blob:)。 */
  const importedTargets: string[] = [];
  const host: ManagerHost = {
    ...real,
    importModule: async (url) => {
      await real.importModule(url).catch(() => {});
      // 真实链路 import 的 target:引用 → 预取 / 新拉的 blob(从 revoke 记录取最后一次);非引用原样。
      importedTargets.push(
        url.startsWith('blob:') ? url : (revokeObjectURL.mock.calls.at(-1)?.[0] as string),
      );
      return { default: TestPlugin };
    },
  };
  const mgr = new PluginManager(createTestCoApp('1.0.0'), host);
  return { mgr, plugins, importedTargets };
}

beforeEach(() => {
  _resetLmApiForTest();
  loaded.length = 0;
  hang.clear();
  blobSeq = 0;
  createObjectURL = vi.fn(() => `blob:${++blobSeq}`);
  revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true, configurable: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  vi.restoreAllMocks();
});

const ok = (dir: string) => ({ ok: true, data: `/* main ${dir} */` });

describe('启动插件源码预取 (B-1)', () => {
  it('第一个插件 onload 完成前,其余已启用插件的 readMainByDir 已并行发出;每个只读一次', async () => {
    hang.set('a', deferred<void>());
    const { mgr, plugins } = setup({
      ids: ['a', 'b', 'c'],
      enabled: ['a', 'b', 'c'],
      readMainByDir: async (dir) => ok(dir),
    });
    const init = mgr.init();
    await flush();
    expect(loaded).toEqual(['a']); // a 的 onload 挂起中
    expect(plugins.readMainByDir.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b', 'c']);
    expect(plugins.readMainByDir).toHaveBeenCalledWith('b', 'hash-b');

    hang.get('a')!.resolve();
    await init;
    expect(loaded).toEqual(['a', 'b', 'c']);
    expect(plugins.readMainByDir).toHaveBeenCalledTimes(3); // 激活命中预取,不重拉
  });

  it('预取有界并发(≤4 在途);源码读取完成顺序打乱时激活顺序仍按 dirs 顺序', async () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const reads = new Map<string, Deferred<unknown>>();
    const { mgr, plugins } = setup({
      ids,
      enabled: ids,
      readMainByDir: (dir) => {
        const d = deferred<unknown>();
        reads.set(dir, d);
        return d.promise;
      },
    });
    const init = mgr.init();
    await flush();
    expect(plugins.readMainByDir).toHaveBeenCalledTimes(4);
    // 逆序完成
    for (const id of [...ids].reverse()) {
      reads.get(id)?.resolve(ok(id));
      await flush();
    }
    for (const id of ids) reads.get(id)?.resolve(ok(id));
    await init;
    expect(loaded).toEqual(ids);
    expect(plugins.readMainByDir).toHaveBeenCalledTimes(6);
  });

  it('禁用插件不预取源码', async () => {
    const { mgr, plugins } = setup({
      ids: ['a', 'b'],
      enabled: ['a'],
      readMainByDir: async (dir) => ok(dir),
    });
    await mgr.init();
    expect(plugins.readMainByDir.mock.calls.map((c) => c[0])).toEqual(['a']);
    expect(loaded).toEqual(['a']);
  });

  it('预取失败不缓存:激活时照常重拉并成功激活', async () => {
    let bCalls = 0;
    const { mgr, plugins } = setup({
      ids: ['a', 'b'],
      enabled: ['a', 'b'],
      readMainByDir: async (dir) =>
        dir === 'b' && ++bCalls === 1 ? { ok: false, code: 'EIO', message: 'disk' } : ok(dir),
    });
    await mgr.init();
    expect(loaded).toEqual(['a', 'b']);
    expect(plugins.readMainByDir.mock.calls.filter((c) => c[0] === 'b')).toHaveLength(2);
    expect(mgr.listAll().find((p) => p.id === 'b')?.status).toBe('enabled');
  });

  it('激活前热重载换了 manifest(令牌不一致)→ 丢弃预取(revoke 其 Blob URL),按新 dirInfo 激活', async () => {
    hang.set('a', deferred<void>());
    const { mgr, plugins, importedTargets } = setup({
      ids: ['a', 'b'],
      enabled: ['a', 'b'],
      readMainByDir: async (dir) => ok(dir),
      readDirById: async (id) => ({
        ok: true,
        data: { id, manifestText: manifest(id, '0.2.0'), manifestHash: 'new-token' },
      }),
    });
    const init = mgr.init();
    await flush();
    // b 的预取已完成:记下它的 Blob URL
    const bIdx = plugins.readMainByDir.mock.calls.findIndex((c) => c[0] === 'b');
    expect(bIdx).toBeGreaterThanOrEqual(0);
    const prefetchedB = createObjectURL.mock.results[bIdx]!.value as string;
    expect(revokeObjectURL).not.toHaveBeenCalledWith(prefetchedB);

    await mgr.reload('b'); // a 仍挂在 onload,b 的锁空闲 → reload 以新 manifest 激活 b
    expect(mgr.listAll().find((p) => p.id === 'b')?.manifest.version).toBe('0.2.0');
    expect(importedTargets).not.toContain(prefetchedB);

    hang.get('a')!.resolve();
    await init;
    expect(revokeObjectURL).toHaveBeenCalledWith(prefetchedB); // 未用上的预取被释放
    expect(loaded).toEqual(['a', 'b']); // b 只激活一次(新 manifest)
    // b 的 main 拉了两次:旧令牌的预取(被丢弃)+ 热重载后按新令牌的激活。
    expect(plugins.readMainByDir.mock.calls.filter((c) => c[0] === 'b').map((c) => c[1])).toEqual([
      expect.not.stringMatching(/^new-token$/),
      'new-token',
    ]);
  });

  it('预取完成后、轮到激活前被禁用 → 不激活,预取的 Blob URL 被 revoke', async () => {
    hang.set('a', deferred<void>());
    const { mgr, plugins } = setup({
      ids: ['a', 'b'],
      enabled: ['a', 'b'],
      readMainByDir: async (dir) => ok(dir),
    });
    const init = mgr.init();
    await flush();
    const bIdx = plugins.readMainByDir.mock.calls.findIndex((c) => c[0] === 'b');
    const prefetchedB = createObjectURL.mock.results[bIdx]!.value as string;

    await mgr.disable('b');
    hang.get('a')!.resolve();
    await init;
    expect(loaded).toEqual(['a']);
    expect(revokeObjectURL).toHaveBeenCalledWith(prefetchedB);
  });

  it('激活加入的在途预取失败 → 照原路径重拉一次并成功激活', async () => {
    const first = deferred<unknown>();
    let aCalls = 0;
    const { mgr, plugins } = setup({
      ids: ['a'],
      enabled: ['a'],
      readMainByDir: (dir) => (++aCalls === 1 ? first.promise : Promise.resolve(ok(dir))),
    });
    const init = mgr.init();
    await flush(); // 激活已在等预取的在途读取
    expect(plugins.readMainByDir).toHaveBeenCalledTimes(1);
    first.resolve({ ok: false, code: 'EIO', message: 'disk' });
    await init;
    expect(plugins.readMainByDir).toHaveBeenCalledTimes(2);
    expect(loaded).toEqual(['a']);
  });

  it('预取在途时插件被禁用 → 读取完成后生成的 Blob URL 立即 revoke(不泄漏、不写回)', async () => {
    hang.set('a', deferred<void>());
    const bRead = deferred<unknown>();
    const { mgr } = setup({
      ids: ['a', 'b'],
      enabled: ['a', 'b'],
      readMainByDir: (dir) => (dir === 'b' ? bRead.promise : Promise.resolve(ok(dir))),
    });
    const init = mgr.init();
    await flush();
    await mgr.disable('b');
    hang.get('a')!.resolve();
    await init;
    expect(loaded).toEqual(['a']);

    const created = createObjectURL.mock.results.length;
    bRead.resolve(ok('b'));
    await flush();
    expect(createObjectURL.mock.results.length).toBe(created + 1);
    const lateB = createObjectURL.mock.results[created]!.value as string;
    expect(revokeObjectURL).toHaveBeenCalledWith(lateB);
  });
});
