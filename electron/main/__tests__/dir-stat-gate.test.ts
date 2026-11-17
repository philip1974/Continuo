import { describe, expect, it, vi } from 'vitest';

const statMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({ promises: { stat: statMock } }));

import {
  createSemaphore,
  DIR_STAT_CONCURRENCY,
  statDirGated,
} from '../lib/dir-stat-gate';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createSemaphore', () => {
  it('同时在途任务数不超过容量,按调用顺序(FIFO)放行,结果/异常原样返回', async () => {
    const sem = createSemaphore(2);
    let inFlight = 0;
    let peak = 0;
    const started: number[] = [];
    const settles: Array<() => void> = [];
    const tasks = Array.from({ length: 6 }, (_, i) =>
      sem.run(
        () =>
          new Promise<number>((resolve, reject) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            started.push(i);
            settles.push(() => {
              inFlight -= 1;
              if (i === 1) reject(new Error('boom'));
              else resolve(i);
            });
          }),
      ),
    );
    const settled = Promise.allSettled(tasks); // 立即挂处理器,防中途 reject 成未处理拒绝
    for (let guard = 0; guard < 100; guard += 1) {
      await tick();
      if (settles.length === 0) break;
      settles.shift()?.();
    }
    const results = await settled;
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect(results[5]).toEqual({ status: 'fulfilled', value: 5 });
  });

  it('任务同步抛错也释放名额', async () => {
    const sem = createSemaphore(1);
    await expect(
      sem.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('createSemaphore · 排队等待上限(防卡死任务造成队头阻塞)', () => {
  it('名额被长期占住时,排队超过 maxWaitMs 的任务直接执行;卡死任务结束后容量记账不变', async () => {
    vi.useFakeTimers();
    try {
      const sem = createSemaphore(2);
      const hung: Array<() => void> = [];
      const hang = (): Promise<void> => new Promise<void>((r) => hung.push(r));
      const h1 = sem.run(hang, 100);
      const h2 = sem.run(hang, 100);
      let healthyRan = false;
      const healthy = sem.run(async () => {
        healthyRan = true;
        return 'ok';
      }, 100);
      await vi.advanceTimersByTimeAsync(99);
      expect(healthyRan).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(healthy).resolves.toBe('ok');

      // 卡死任务结束 → 释放的名额不会交给已超时离队的等待者,容量仍为 2。
      hung.splice(0).forEach((r) => r());
      await Promise.all([h1, h2]);
      let inFlight = 0;
      let peak = 0;
      const settles: Array<() => void> = [];
      const tasks = Array.from({ length: 4 }, () =>
        sem.run(
          () =>
            new Promise<void>((resolve) => {
              inFlight += 1;
              peak = Math.max(peak, inFlight);
              settles.push(() => {
                inFlight -= 1;
                resolve();
              });
            }),
          100,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(peak).toBe(2);
      while (settles.length > 0) {
        settles.shift()?.();
        await vi.advanceTimersByTimeAsync(0);
      }
      await Promise.all(tasks);
      expect(peak).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('statDirGated · 超时离队者走容量有限的溢出通道', () => {
  it('2 个卡死 stat 占住名额时,多个超时离队者不得同时直行:总在途 ≤ 容量 + 1', async () => {
    vi.useFakeTimers();
    try {
      statMock.mockReset();
      let inFlight = 0;
      let peak = 0;
      statMock.mockImplementation(
        () =>
          new Promise(() => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
          }),
      );
      // 独立模块实例:卡死的 stat 永不结算,不得占住其它用例共用的单例闸。
      vi.resetModules();
      const fresh = await import('../lib/dir-stat-gate');
      for (let i = 0; i < 8; i++) void fresh.statDirGated(`/dead/${i}`).catch(() => {});
      await vi.advanceTimersByTimeAsync(10_000);
      expect(peak).toBe(fresh.DIR_STAT_CONCURRENCY + 1);
    } finally {
      statMock.mockReset();
      vi.useRealTimers();
    }
  });
});

describe('statDirGated · 离队者在主闸 / 溢出闸之间回流', () => {
  it('溢出闸被永久卡死、主闸的慢 stat 随后返回 → 已离队的健康判定最终完成', async () => {
    vi.useFakeTimers();
    try {
      statMock.mockReset();
      const slow: Array<() => void> = [];
      statMock.mockImplementation((p: string) => {
        if (p.startsWith('/slow/')) return new Promise((r) => slow.push(() => r({ p })));
        if (p.startsWith('/dead/')) return new Promise(() => {});
        return Promise.resolve({ p });
      });
      vi.resetModules();
      const fresh = await import('../lib/dir-stat-gate');
      void fresh.statDirGated('/slow/1');
      void fresh.statDirGated('/slow/2');
      void fresh.statDirGated('/dead/x').catch(() => {});
      await vi.advanceTimersByTimeAsync(fresh.DIR_STAT_MAX_WAIT_MS + 10); // dead/x 离队并卡死溢出闸
      let healthyDone = false;
      void fresh.statDirGated('/local/ok').then(() => {
        healthyDone = true;
      });
      await vi.advanceTimersByTimeAsync(fresh.DIR_STAT_MAX_WAIT_MS + 10); // 健康判定也离队
      slow.splice(0).forEach((r) => r()); // 主闸慢 stat 返回,名额空出
      await vi.advanceTimersByTimeAsync(fresh.DIR_STAT_MAX_WAIT_MS * 3);
      expect(healthyDone).toBe(true);
    } finally {
      statMock.mockReset();
      vi.useRealTimers();
    }
  });
});

describe('statDirGated · 目录判定 stat 全局并发闸', () => {
  it('容量为 2(libuv 默认 4 线程,至少留一半给保存 / listDir / 持久化)', () => {
    expect(DIR_STAT_CONCURRENCY).toBe(2);
  });

  it('并发调用时同时在途 stat ≤ DIR_STAT_CONCURRENCY,错误原样透传', async () => {
    let inFlight = 0;
    let peak = 0;
    const settles: Array<() => void> = [];
    statMock.mockImplementation(
      (p: string) =>
        new Promise((resolve, reject) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          settles.push(() => {
            inFlight -= 1;
            if (p === '/gone') reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
            else resolve({ isDirectory: () => true });
          });
        }),
    );
    const settled = Promise.allSettled(['/a', '/gone', '/b', '/c', '/d'].map((p) => statDirGated(p)));
    for (let guard = 0; guard < 100; guard += 1) {
      await tick();
      if (settles.length === 0) break;
      settles.shift()?.();
    }
    const results = await settled;
    expect(peak).toBe(DIR_STAT_CONCURRENCY);
    expect(statMock.mock.calls.map((c) => c[0])).toEqual(['/a', '/gone', '/b', '/c', '/d']);
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'ENOENT' } });
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
  });
});
