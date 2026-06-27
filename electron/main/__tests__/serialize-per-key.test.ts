// race(R17):serializePerKey 把按 key 的异步任务串行化(按调用顺序依次执行,前次失败不阻断后续)。
import { describe, expect, it, vi } from 'vitest';
import {
  serializePerKey,
  runSerialPerKey,
} from '../services/serialize-per-key';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('serializePerKey (R17)', () => {
  it('同 key:第二个任务在第一个完成后才启动(按调用顺序串行)', async () => {
    const chains = new Map<string, Promise<void>>();
    const order: string[] = [];
    const d1 = deferred();

    const task1 = vi.fn(async () => {
      order.push('start-1');
      await d1.promise;
      order.push('end-1');
    });
    const task2 = vi.fn(async () => {
      order.push('start-2');
    });

    serializePerKey(chains, 'k', task1);
    serializePerKey(chains, 'k', task2);
    await Promise.resolve();

    // task1 已启动,task2 尚未(等 task1 完成)
    expect(task1).toHaveBeenCalledTimes(1);
    expect(task2).not.toHaveBeenCalled();

    d1.resolve();
    await chains.get('k');

    // task2 在 task1 end 之后才 start —— 严格保序
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
  });

  it('不同 key 互不阻塞(并行)', async () => {
    const chains = new Map<string, Promise<void>>();
    const dA = deferred();
    const taskA = vi.fn(async () => {
      await dA.promise;
    });
    const taskB = vi.fn(async () => {});

    serializePerKey(chains, 'A', taskA);
    serializePerKey(chains, 'B', taskB);
    await Promise.resolve();

    // A 挂起不影响 B
    expect(taskA).toHaveBeenCalledTimes(1);
    expect(taskB).toHaveBeenCalledTimes(1);
    dA.resolve();
    await Promise.all([chains.get('A'), chains.get('B')]);
  });

  it('前一个任务失败不阻断后续任务(链尾吞错)', async () => {
    const chains = new Map<string, Promise<void>>();
    const task1 = vi.fn(async () => {
      throw new Error('boom');
    });
    const task2 = vi.fn(async () => {});

    serializePerKey(chains, 'k', task1);
    serializePerKey(chains, 'k', task2);
    await chains.get('k');

    expect(task1).toHaveBeenCalledTimes(1);
    expect(task2).toHaveBeenCalledTimes(1);
  });

  // race(R100):链排空后必须从 chains 删除 key,否则 Map 随用过的 key 单调增长 = 内存泄漏。
  it('链排空后删除条目,不随 key 单调增长(防内存泄漏)', async () => {
    const chains = new Map<string, Promise<void>>();
    const tail = serializePerKeyAwaitable(chains, 'k', async () => {});
    expect(chains.has('k')).toBe(true); // 在途时占位
    await tail;
    await Promise.resolve(); // 让 cleanup 微任务跑
    expect(chains.has('k')).toBe(false); // 排空后回收
  });

  it('失败链排空后同样删除条目', async () => {
    const chains = new Map<string, Promise<void>>();
    const tail = serializePerKeyAwaitable(chains, 'k', async () => {
      throw new Error('boom');
    });
    await tail;
    await Promise.resolve();
    expect(chains.has('k')).toBe(false);
  });

  it('cleanup 前有新任务入队 → 不误删,保持链完整', async () => {
    const chains = new Map<string, Promise<void>>();
    const order: string[] = [];
    const d1 = deferred();
    serializePerKey(chains, 'k', async () => {
      order.push('s1');
      await d1.promise;
      order.push('e1');
    });
    serializePerKey(chains, 'k', async () => {
      order.push('s2');
    });
    d1.resolve();
    const tail = chains.get('k');
    await tail;
    expect(order).toEqual(['s1', 'e1', 's2']); // 链未被误删 → 保序
    await Promise.resolve();
    expect(chains.has('k')).toBe(false); // 全排空后回收
  });
});

// serializePerKey 是 void(fire-and-forget),测删除需拿到尾 promise。重做最小入队拿尾。
function serializePerKeyAwaitable(
  chains: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<void>,
): Promise<void> {
  serializePerKey(chains, key, task);
  return chains.get(key)!;
}

// race(R100/R101):runSerialPerKey 返回结果版,串行 + 排空回收。withInstallLock 收口到它。
describe('runSerialPerKey (R100/R101)', () => {
  it('返回本次任务真实结果', async () => {
    const chains = new Map<string, Promise<unknown>>();
    await expect(runSerialPerKey(chains, 'k', async () => 42)).resolves.toBe(42);
  });

  it('同 key 严格保序', async () => {
    const chains = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    const d1 = deferred();
    const r1 = runSerialPerKey(chains, 'k', async () => {
      order.push('s1');
      await d1.promise;
      order.push('e1');
    });
    const r2 = runSerialPerKey(chains, 'k', async () => {
      order.push('s2');
    });
    await Promise.resolve();
    expect(order).toEqual(['s1']);
    d1.resolve();
    await Promise.all([r1, r2]);
    expect(order).toEqual(['s1', 'e1', 's2']);
  });

  it('前次失败不阻断后续(链尾吞错)', async () => {
    const chains = new Map<string, Promise<unknown>>();
    await expect(
      runSerialPerKey(chains, 'k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(runSerialPerKey(chains, 'k', async () => 7)).resolves.toBe(7);
  });

  it('链排空后删除 key(防内存泄漏)', async () => {
    const chains = new Map<string, Promise<unknown>>();
    await runSerialPerKey(chains, 'k', async () => {});
    await Promise.resolve();
    expect(chains.has('k')).toBe(false);
  });

  it('失败链排空后同样删除 key', async () => {
    const chains = new Map<string, Promise<unknown>>();
    await runSerialPerKey(chains, 'k', async () => {
      throw new Error('boom');
    }).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(chains.has('k')).toBe(false);
  });
});
