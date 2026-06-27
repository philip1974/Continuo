// BDD: map-with-concurrency (E234/E251)
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { allSettledWithConcurrency } from '../../lib/map-with-concurrency';

describe('allSettledWithConcurrency', () => {
  it('启动 worker 不通过 Array.from({ length }) 构造临时数组', async () => {
    const fromSpy = vi.spyOn(Array, 'from');

    try {
      const r = await allSettledWithConcurrency([1, 2, 3], 2, async (n) => n);
      expect(r.map((x) => (x.status === 'fulfilled' ? x.value : null))).toEqual([
        1, 2, 3,
      ]);
      expect(fromSpy).not.toHaveBeenCalled();
    } finally {
      fromSpy.mockRestore();
    }
  });

  it('worker promise 数组按 workerCount 预分配,不通过 workers.push 扩容', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'src/lib/map-with-concurrency.ts'),
      'utf-8',
    );
    expect(src).toMatch(/new Array<Promise<void>>\(workerCount\)/);
    expect(src).not.toMatch(/workers\.push\(/);
  });

  it('结果按输入顺序对位 + allSettled 语义(单失败不影响其它)', async () => {
    const r = await allSettledWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n * 10;
    });
    expect(r).toEqual([
      { status: 'fulfilled', value: 10 },
      { status: 'rejected', reason: new Error('boom') },
      { status: 'fulfilled', value: 30 },
    ]);
  });

  it('单项输入直接执行,不启动 worker 池 / Promise.all', async () => {
    const allSpy = vi.spyOn(Promise, 'all');

    try {
      await expect(
        allSettledWithConcurrency([2], 4, async (n) => n * 10),
      ).resolves.toEqual([{ status: 'fulfilled', value: 20 }]);
      await expect(
        allSettledWithConcurrency([2], 4, async () => {
          throw new Error('boom');
        }),
      ).resolves.toEqual([{ status: 'rejected', reason: new Error('boom') }]);
      expect(allSpy).not.toHaveBeenCalled();
    } finally {
      allSpy.mockRestore();
    }
  });

  it('峰值在途 ≤ limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const releasers: (() => void)[] = [];
    const N = 20;
    const p = allSettledWithConcurrency(
      Array.from({ length: N }, (_, i) => i),
      4,
      () =>
        new Promise<number>((res) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          releasers.push(() => {
            inFlight -= 1;
            res(1);
          });
        }),
    );
    // 逐个放行
    let released = 0;
    while (released < N) {
      await Promise.resolve();
      while (released < releasers.length) {
        releasers[released]!();
        released += 1;
      }
    }
    await p;
    expect(peak).toBe(4);
  });

  // 边界(E251):limit 非有限/≤0/小数 → 归一化,绝不 0 worker 静默丢任务。
  it.each([NaN, 0, -3, Infinity, -Infinity])(
    'limit 畸形(%o)→ 仍执行全部任务(不静默丢)',
    async (badLimit) => {
      const ran: number[] = [];
      const r = await allSettledWithConcurrency(
        [1, 2, 3],
        badLimit as number,
        async (n) => {
          ran.push(n);
          return n;
        },
      );
      expect(ran.sort()).toEqual([1, 2, 3]); // 全部执行,无空洞
      expect(r.map((x) => (x.status === 'fulfilled' ? x.value : null))).toEqual([
        1, 2, 3,
      ]);
    },
  );

  it('limit 小数 → Math.trunc 不报错且全执行', async () => {
    const r = await allSettledWithConcurrency([1, 2], 1.9, async (n) => n);
    expect(r).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 },
    ]);
  });

  it('空输入 → []', async () => {
    const allSpy = vi.spyOn(Promise, 'all');

    try {
      const r = await allSettledWithConcurrency([], 4, async (n) => n);
      expect(r).toEqual([]);
      expect(r).toBe(await allSettledWithConcurrency([], 1, async (n) => n));
      expect(allSpy).not.toHaveBeenCalled();
    } finally {
      allSpy.mockRestore();
    }
  });
});
