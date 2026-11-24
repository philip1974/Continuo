import { describe, expect, it } from 'vitest';
import { mapInOrderBounded } from '../lib/map-in-order-bounded';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('mapInOrderBounded', () => {
  it('结果按输入顺序对位(与完成顺序无关)', async () => {
    const delays = [30, 0, 10, 5];
    const out = await mapInOrderBounded(delays, 2, async (d) => {
      await new Promise((r) => setTimeout(r, d));
      return d * 2;
    });
    expect(out).toEqual([60, 0, 20, 10]);
  });

  it('同时在跑的任务数不超过 limit', async () => {
    let running = 0;
    let peak = 0;
    await mapInOrderBounded([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
    });
    expect(peak).toBe(3);
  });

  it('空输入 → 空数组,不调用 fn', async () => {
    let calls = 0;
    expect(await mapInOrderBounded([], 4, async () => (calls += 1))).toEqual([]);
    expect(calls).toBe(0);
  });

  it('任一任务 reject → 整体 reject(fail-fast)', async () => {
    await expect(
      mapInOrderBounded([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
