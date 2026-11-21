// race(R100):runSerialPerKey 链排空后必须删除 chains 条目,否则 Map 随用过的 key 单调增长 = 内存泄漏。
import { describe, expect, it } from 'vitest';
import { runSerialPerKey } from '@/lib/serialize-per-key';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runSerialPerKey 链排空回收(R100)', () => {
  it('成功任务排空后删除 key(防 Map 单调增长)', async () => {
    const chains = new Map<string, Promise<unknown>>();
    const r = runSerialPerKey(chains, 'k', async () => 42);
    expect(chains.has('k')).toBe(true); // 在途占位
    await expect(r).resolves.toBe(42);
    await Promise.resolve(); // cleanup 微任务
    expect(chains.has('k')).toBe(false); // 排空回收
  });

  it('失败任务排空后同样删除 key', async () => {
    const chains = new Map<string, Promise<unknown>>();
    const r = runSerialPerKey(chains, 'k', async () => {
      throw new Error('boom');
    });
    await expect(r).rejects.toThrow('boom');
    await Promise.resolve();
    await Promise.resolve();
    expect(chains.has('k')).toBe(false);
  });

  it('cleanup 前有新任务入队 → 不误删,保持串行保序', async () => {
    const chains = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    const d1 = deferred();
    const r1 = runSerialPerKey(chains, 'k', async () => {
      order.push('s1');
      await d1.promise;
      order.push('e1');
      return 1;
    });
    const r2 = runSerialPerKey(chains, 'k', async () => {
      order.push('s2');
      return 2;
    });
    await Promise.resolve();
    expect(order).toEqual(['s1']); // r2 等 r1
    d1.resolve();
    await Promise.all([r1, r2]);
    expect(order).toEqual(['s1', 'e1', 's2']); // 链未被误删 → 严格保序
    await Promise.resolve();
    expect(chains.has('k')).toBe(false); // 全排空后回收
  });

  it('多 key 各自独立回收', async () => {
    const chains = new Map<string, Promise<unknown>>();
    await Promise.all([
      runSerialPerKey(chains, 'a', async () => 1),
      runSerialPerKey(chains, 'b', async () => 2),
      runSerialPerKey(chains, 'c', async () => 3),
    ]);
    await Promise.resolve();
    expect(chains.size).toBe(0);
  });
});
