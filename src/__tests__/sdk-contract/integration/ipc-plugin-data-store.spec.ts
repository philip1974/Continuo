import { beforeEach, describe, expect, it, vi } from 'vitest';

const coApiMocks = vi.hoisted(() => ({
  load: vi.fn(),
  saveSerialized: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginDataRaw: {
      load: coApiMocks.load,
      saveSerialized: coApiMocks.saveSerialized,
    },
  },
}));

import { IpcPluginDataStore } from '../../../plugins/PluginDataStore';
import { MAX_PLUGIN_DATA_BYTES } from '../../../../electron/shared/plugin-data-limits';

beforeEach(() => {
  vi.clearAllMocks();
  coApiMocks.load.mockResolvedValue({});
  coApiMocks.saveSerialized.mockResolvedValue(undefined);
});

describe('sdk-contract integration: IpcPluginDataStore wrapper', () => {
  it('T4.a maps raw empty object to plugin-facing null', async () => {
    const store = new IpcPluginDataStore();
    coApiMocks.load.mockResolvedValueOnce({});

    await expect(store.read('plugin.data')).resolves.toBeNull();
    expect(coApiMocks.load).toHaveBeenCalledWith('plugin.data');
  });

  // perf P2:传预检时已算好的 value 序列化串(main 侧包成 { value } 落盘),不再结构化克隆对象图。
  it('T4.b writes pass the already-serialized value string through raw IPC', async () => {
    const store = new IpcPluginDataStore();
    const data = { theme: 'dark' };

    await store.write('plugin.data', data);

    expect(coApiMocks.saveSerialized).toHaveBeenCalledWith('plugin.data', '{"theme":"dark"}');
  });

  it('T4.b2 非 JSON 安全值仍在 renderer 拒绝(不发 IPC)', async () => {
    const store = new IpcPluginDataStore();
    for (const bad of [{ x: Number.NaN }, { y: undefined }, { f: () => 1 }, 1n]) {
      await expect(store.write('plugin.data', bad)).rejects.toThrow();
    }
    expect(coApiMocks.saveSerialized).not.toHaveBeenCalled();
  });

  // 边界(E43,E41/E42 同族):write() 在 renderer JSON.stringify 后按主进程同一上限预检,超限
  // 直接抛、不发 IPC(save)、不提交 cache,挡主进程 16MiB cap 之前的 renderer 前置放大。
  it('E43 超过 MAX_PLUGIN_DATA_BYTES → 抛且不调 save', async () => {
    const store = new IpcPluginDataStore();
    // 多段子上限字符串累加超 16MiB 字节(每段 < E285 单字符串值上限),命中序列化字节 cap
    // (/too large/)而非 E285 单值长度 cap;验证 renderer 端 stringify 后字节预检挡 IPC。
    const chunk = 'x'.repeat(1024 * 1024);
    const huge = Array.from(
      { length: Math.ceil(MAX_PLUGIN_DATA_BYTES / chunk.length) + 1 },
      () => chunk,
    );
    await expect(store.write('plugin.data', huge)).rejects.toThrow(
      /too large/i,
    );
    expect(coApiMocks.saveSerialized).not.toHaveBeenCalled();
  });

  it('E43 上限内正常写 → 正常 save', async () => {
    const store = new IpcPluginDataStore();
    await store.write('plugin.data', { ok: true });
    expect(coApiMocks.saveSerialized).toHaveBeenCalledWith('plugin.data', '{"ok":true}');
  });

  it('T4.c reads from cache after write without calling raw load', async () => {
    const store = new IpcPluginDataStore();
    const data = { theme: 'dark' };

    await store.write('plugin.data', data);
    await expect(store.read('plugin.data')).resolves.toBe(data);

    expect(coApiMocks.load).not.toHaveBeenCalled();
  });

  it('T4.d coalesces concurrent reads for the same pluginId', async () => {
    const store = new IpcPluginDataStore();
    coApiMocks.load.mockResolvedValueOnce({ value: { ready: true } });

    const [a, b] = await Promise.all([
      store.read('plugin.data'),
      store.read('plugin.data'),
    ]);

    expect(a).toEqual({ ready: true });
    expect(b).toEqual({ ready: true });
    expect(coApiMocks.load).toHaveBeenCalledTimes(1);
  });

  // perf(#2):进程级单例 store 的 cache 在插件卸载后必须可淘汰(单插件最多 16MiB,每 renderer 一份),
  // 且迟到的 load / save 不得把已卸载插件的数据回填;同 id 重装后读到新数据。
  describe('forget(pluginId):卸载后淘汰缓存', () => {
    function deferred<T>() {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    it('forget 后缓存清空:再次 read 重新走 load', async () => {
      const store = new IpcPluginDataStore();
      await store.write('plugin.data', { big: 'old' });
      store.forget('plugin.data');
      coApiMocks.load.mockResolvedValueOnce({});
      await expect(store.read('plugin.data')).resolves.toBeNull();
      expect(coApiMocks.load).toHaveBeenCalledTimes(1);
    });

    it('load 在途时 forget → 迟到的 load 结果不回填缓存', async () => {
      const store = new IpcPluginDataStore();
      const d = deferred<Record<string, unknown>>();
      coApiMocks.load.mockReturnValueOnce(d.promise);
      const pending = store.read('plugin.data');
      store.forget('plugin.data');
      d.resolve({ value: { stale: true } });
      await pending;
      // 重装后的新数据必须从盘读,而不是命中卸载前在途 load 的快照
      coApiMocks.load.mockResolvedValueOnce({ value: { fresh: true } });
      await expect(store.read('plugin.data')).resolves.toEqual({ fresh: true });
      expect(coApiMocks.load).toHaveBeenCalledTimes(2);
    });

    it('save 在途时 forget → 迟到的 save 不回填缓存', async () => {
      const store = new IpcPluginDataStore();
      const d = deferred<undefined>();
      coApiMocks.saveSerialized.mockReturnValueOnce(d.promise);
      const pending = store.write('plugin.data', { stale: true });
      store.forget('plugin.data');
      d.resolve(undefined);
      await pending;
      coApiMocks.load.mockResolvedValueOnce({ value: { fresh: true } });
      await expect(store.read('plugin.data')).resolves.toEqual({ fresh: true });
    });

    it('forget 后同 id 重装:新的 read / write 正常缓存', async () => {
      const store = new IpcPluginDataStore();
      await store.write('plugin.data', { v: 1 });
      store.forget('plugin.data');
      await store.write('plugin.data', { v: 2 });
      await expect(store.read('plugin.data')).resolves.toEqual({ v: 2 });
      expect(coApiMocks.load).not.toHaveBeenCalled();
    });

    it('forget 只影响目标插件', async () => {
      const store = new IpcPluginDataStore();
      await store.write('a', { a: 1 });
      await store.write('b', { b: 1 });
      store.forget('a');
      await expect(store.read('b')).resolves.toEqual({ b: 1 });
      expect(coApiMocks.load).not.toHaveBeenCalled();
    });
  });
});
