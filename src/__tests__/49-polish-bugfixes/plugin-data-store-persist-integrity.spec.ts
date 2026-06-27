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

// race(R61):同一 pluginId 的并发 write 必须按调用顺序落地(后发起者最后提交)。主进程 lock 只保
// 文件不损坏、不保顺序;renderer 须 per-plugin 写链串行化,否则后发写被先发但 save 迟到者覆盖。
describe('race(R61) · IpcPluginDataStore.write 同 plugin 写写串行', () => {
  it('并发 write(A) 先发但 save 后 resolve、write(B) 后发先 resolve → 最终 read 是 B', async () => {
    const store = new IpcPluginDataStore();
    // 控制两次 save 的 resolve 时机:A 的 save 故意晚于 B resolve(乱序)。
    let resolveA: () => void = () => {};
    let resolveB: () => void = () => {};
    coApiMocks.save
      .mockImplementationOnce(() => new Promise<void>((r) => { resolveA = r; }))
      .mockImplementationOnce(() => new Promise<void>((r) => { resolveB = r; }));

    const pA = store.write('p', { v: 'A' }); // 先发起(进链)
    const pB = store.write('p', { v: 'B' }); // 后发起(排在 A 之后)

    // taskA 在微任务里才跑到 save#1(此刻才设 resolveA);先 yield 让它跑,再放行 A。
    await Promise.resolve();
    await Promise.resolve();
    resolveA();
    await pA; // A 落地 → 触发 B 入链
    // B 的 task 在微任务里跑到 save#2(设 resolveB);yield 后再放行 B。
    await Promise.resolve();
    await Promise.resolve();
    resolveB();
    await pB;

    // 后发起的 B 最后落地;read 返回 B 而非被 A 覆盖。
    await expect(store.read('p')).resolves.toEqual({ v: 'B' });
    // 串行保证:save 按调用顺序依次发(A 的 value 先,B 的 value 后)。
    expect(coApiMocks.save.mock.calls.map((c) => c[1])).toEqual([
      { value: { v: 'A' } },
      { value: { v: 'B' } },
    ]);
  });

  it('写链中一次 save reject 不卡死后续 write(链续跑)', async () => {
    const store = new IpcPluginDataStore();
    coApiMocks.save
      .mockRejectedValueOnce(new Error('ENOSPC')) // 第一次失败
      .mockResolvedValueOnce(undefined); // 第二次成功

    const p1 = store.write('p', { v: 'fail' });
    const p2 = store.write('p', { v: 'ok' });
    await expect(p1).rejects.toThrow('ENOSPC');
    await expect(p2).resolves.toBeUndefined();
    await expect(store.read('p')).resolves.toEqual({ v: 'ok' });
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

// race(R11):read 触发的 load IPC 在途期间发生 write() → 旧 load 返回时不得用过期磁盘快照
// 回滚 cache(write 已写更新值),否则同插件 stale read/write lost update。
describe('race(R11) · load 在途 write 不被旧 load 回滚', () => {
  it('read 触发 load 在途 → write 新值 → 旧 load 返回不回滚,后续 read 得新值', async () => {
    const store = new IpcPluginDataStore();
    let resolveLoad!: (v: unknown) => void;
    coApiMocks.load.mockReturnValue(
      new Promise((res) => {
        resolveLoad = res;
      }),
    );
    coApiMocks.save.mockResolvedValue(undefined);

    // 1. read 触发 load(in-flight,未返回)
    const readP = store.read('p');
    // 2. load 未返回前 write 新值(save 成功 → cache=new, writeGen++)
    await store.write('p', { v: 'new' });
    // 3. 旧 load 返回过期磁盘值
    resolveLoad({ value: { v: 'old-disk' } });
    await readP;

    // 4. cache 不被旧磁盘值回滚 → 后续 read 命中缓存返回 write 的新值
    await expect(store.read('p')).resolves.toEqual({ v: 'new' });
  });
});
