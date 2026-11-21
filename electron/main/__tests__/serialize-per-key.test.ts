// race(R17/R100/R101):runSerialPerKey 把按 key 的异步任务串行化(按调用顺序依次执行,前次失败不阻断后续)。
import { describe, expect, it } from 'vitest';
import { runSerialPerKey } from '../services/serialize-per-key';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
