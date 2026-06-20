// topic 49 · P1-BE / P2-BF:IpcPluginDataStore 落盘失败语义。
//
// P1-BE(write 假持久化):旧实现 write 先写 cache + 标 loaded 再 await save。
//   若 save reject(磁盘满 / userData 只读 / IPC 关闭),缓存已被新值污染且 loaded
//   置位 → 后续 read() 命中 loaded 分支返回这个**从未落盘**的值,让插件误以为已
//   保存(实则重启后丢失),即便插件 catch 了本次异常也无法在重试时察觉真实状态。
//   修复:缓存写入移到 await save 成功之后。
//
// P2-BF(load 永久缓存 rejected promise):旧实现把 in-flight promise 存进 loading,
//   但 loading.delete 写在 `await coApi.pluginDataRaw.load` 之后。若 load reject,
//   delete 永不执行,rejected promise 永久留在 map → 后续 read() 命中 existing 返回
//   同一个 reject → 瞬时 IPC 错误后永远无法重试,直到整页刷新。修复:try/finally。

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

import { IpcPluginDataStore } from '../../plugins/PluginDataStore';

beforeEach(() => {
  vi.clearAllMocks();
  coApiMocks.load.mockResolvedValue({});
  coApiMocks.save.mockResolvedValue(undefined);
});

describe('topic49 P1-BE · IpcPluginDataStore.write 落盘失败不污染缓存', () => {
  it('save reject 时 read 反映真实磁盘态(不返回从未落盘的内存值)', async () => {
    const store = new IpcPluginDataStore();
    coApiMocks.save.mockRejectedValueOnce(new Error('ENOSPC'));
    coApiMocks.load.mockResolvedValue({ value: { v: 'disk-old' } });

    await expect(store.write('p', { v: 'mem-new' })).rejects.toThrow('ENOSPC');

    // 失败后 read 必须走 load 读真实磁盘值,而不是命中缓存返回从未落盘的 'mem-new'
    await expect(store.read('p')).resolves.toEqual({ v: 'disk-old' });
    expect(coApiMocks.load).toHaveBeenCalledWith('p');
  });

  it('save 成功后 read 命中缓存不再 load(成功路径契约保持)', async () => {
    const store = new IpcPluginDataStore();
    const data = { v: 'ok' };

    await store.write('p', data);
    await expect(store.read('p')).resolves.toBe(data);

    expect(coApiMocks.load).not.toHaveBeenCalled();
  });
});

describe('topic49 P2-BF · IpcPluginDataStore.load 失败后可重试', () => {
  it('load reject 后下次 read 重新发起 load(不缓存 rejected promise)', async () => {
    const store = new IpcPluginDataStore();
    coApiMocks.load.mockRejectedValueOnce(new Error('IPC not ready'));

    await expect(store.read('p')).rejects.toThrow('IPC not ready');

    // 瞬时错误恢复后再读应重新 load 并成功,而非命中缓存的 rejected promise 永久失败
    coApiMocks.load.mockResolvedValueOnce({ value: { v: 'recovered' } });
    await expect(store.read('p')).resolves.toEqual({ v: 'recovered' });
    expect(coApiMocks.load).toHaveBeenCalledTimes(2);
  });
});
