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
