import { afterEach, describe, expect, it, vi } from 'vitest';
import { sleep, waitAtMost } from '../lib/wait-at-most';

afterEach(() => {
  vi.useRealTimers();
});

describe('waitAtMost', () => {
  it('p 先完成 → done,并清掉计时器', async () => {
    vi.useFakeTimers();
    const r = waitAtMost(Promise.resolve(1), 1_000);
    await expect(r).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('超时先到 → timeout(不 reject)', async () => {
    vi.useFakeTimers();
    const r = waitAtMost(new Promise(() => {}), 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(r).resolves.toBe('timeout');
  });

  it('p 在超时前 reject → 原样 reject,计时器被清', async () => {
    vi.useFakeTimers();
    const r = waitAtMost(Promise.reject(new Error('boom')), 1_000);
    await expect(r).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unref:true → 计时器不挂住进程', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const p = waitAtMost(new Promise(() => {}), 10, { unref: true });
    const timer = spy.mock.results.at(-1)?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await p;
    spy.mockRestore();
  });
});

describe('sleep', () => {
  it('ms 后 resolve', async () => {
    vi.useFakeTimers();
    let done = false;
    void sleep(500).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
});
