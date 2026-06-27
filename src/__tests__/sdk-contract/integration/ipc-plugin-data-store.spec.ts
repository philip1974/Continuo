import { beforeEach, describe, expect, it, vi } from 'vitest';

const coApiMocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginDataRaw: {
      load: coApiMocks.load,
      save: coApiMocks.save,
    },
  },
}));

import { IpcPluginDataStore } from '../../../plugins/PluginDataStore';
import { MAX_PLUGIN_DATA_BYTES } from '../../../../electron/shared/plugin-data-limits';

beforeEach(() => {
  vi.clearAllMocks();
  coApiMocks.load.mockResolvedValue({});
  coApiMocks.save.mockResolvedValue(undefined);
});

describe('sdk-contract integration: IpcPluginDataStore wrapper', () => {
  it('T4.a maps raw empty object to plugin-facing null', async () => {
    const store = new IpcPluginDataStore();
    coApiMocks.load.mockResolvedValueOnce({});

    await expect(store.read('plugin.data')).resolves.toBeNull();
    expect(coApiMocks.load).toHaveBeenCalledWith('plugin.data');
  });

  it('T4.b wraps writes as { value } before saving through raw IPC', async () => {
    const store = new IpcPluginDataStore();
    const data = { theme: 'dark' };

    await store.write('plugin.data', data);

    expect(coApiMocks.save).toHaveBeenCalledWith('plugin.data', { value: data });
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
    expect(coApiMocks.save).not.toHaveBeenCalled();
  });

  it('E43 上限内正常写 → 正常 save', async () => {
    const store = new IpcPluginDataStore();
    await store.write('plugin.data', { ok: true });
    expect(coApiMocks.save).toHaveBeenCalledWith('plugin.data', {
      value: { ok: true },
    });
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
});
