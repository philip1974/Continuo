import { describe, expect, it } from 'vitest';
import { createRwLock } from '../lib/rw-lock';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('createRwLock', () => {
  it('共享持有者可并行', async () => {
    const lock = createRwLock();
    const gate = deferred();
    const log: string[] = [];
    const a = lock.shared(async () => {
      log.push('a-in');
      await gate.promise;
    });
    const b = lock.shared(async () => {
      log.push('b-in');
    });
    await b;
    expect(log).toEqual(['a-in', 'b-in']);
    gate.resolve();
    await a;
  });

  it('独占与共享、独占与独占互斥', async () => {
    const lock = createRwLock();
    const gate = deferred();
    const log: string[] = [];
    const r = lock.shared(async () => {
      await gate.promise;
      log.push('r-out');
    });
    const w1 = lock.exclusive(async () => {
      log.push('w1-in');
      await tick();
      log.push('w1-out');
    });
    const w2 = lock.exclusive(async () => {
      log.push('w2-in');
    });
    await tick();
    expect(log).toEqual([]);
    gate.resolve();
    await Promise.all([r, w1, w2]);
    expect(log).toEqual(['r-out', 'w1-in', 'w1-out', 'w2-in']);
  });

  it('公平排队:独占在等待时,后到的共享排在它后面(写者不饿死)', async () => {
    const lock = createRwLock();
    const gate = deferred();
    const log: string[] = [];
    const r1 = lock.shared(() => gate.promise);
    const w = lock.exclusive(async () => {
      log.push('w');
    });
    const r2 = lock.shared(async () => {
      log.push('r2');
    });
    await tick();
    expect(log).toEqual([]);
    gate.resolve();
    await Promise.all([r1, w, r2]);
    expect(log).toEqual(['w', 'r2']);
  });

  it('任务抛错(同步或异步)后释放,并把错误原样传出', async () => {
    const lock = createRwLock();
    await expect(
      lock.exclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(
      lock.shared(() => {
        throw new Error('sync boom');
      }),
    ).rejects.toThrow('sync boom');
    expect(await lock.exclusive(async () => 42)).toBe(42);
  });

  it('exclusiveGrants 只在独占被授予时 +1;isExclusiveHeld 只在独占任务运行期间为 true', async () => {
    const lock = createRwLock();
    expect(lock.exclusiveGrants()).toBe(0);
    expect(lock.isExclusiveHeld()).toBe(false);
    await lock.shared(() => {
      expect(lock.isExclusiveHeld()).toBe(false);
    });
    expect(lock.exclusiveGrants()).toBe(0);
    const gate = deferred();
    const reader = lock.shared(() => gate.promise);
    const writer = lock.exclusive(() => {
      expect(lock.isExclusiveHeld()).toBe(true);
      expect(lock.exclusiveGrants()).toBe(1);
    });
    await tick();
    expect(lock.exclusiveGrants()).toBe(0); // 还在排队:未授予不计数
    gate.resolve();
    await Promise.all([reader, writer]);
    expect(lock.isExclusiveHeld()).toBe(false);
    await lock.exclusive(() => Promise.reject(new Error('boom'))).catch(() => {});
    expect(lock.exclusiveGrants()).toBe(2);
    expect(lock.isExclusiveHeld()).toBe(false);
  });
});
