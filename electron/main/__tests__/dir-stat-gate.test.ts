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
