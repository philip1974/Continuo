import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetExplorerFileMutex,
  withExplorerFileMutex,
} from '../../../electron/main/lib/file-mutex';

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

beforeEach(() => {
  _resetExplorerFileMutex();
});

describe('explorer persistence file mutex', () => {
  it('T18: runs concurrent calls one at a time in call order', async () => {
    const startedAt: number[] = [];
    const activeCounts: number[] = [];
    let active = 0;

    await Promise.all(
      [0, 1, 2].map((id) =>
        withExplorerFileMutex(async () => {
          active += 1;
          activeCounts.push(active);
          startedAt[id] = performance.now();
          await delay(8);
          active -= 1;
        }),
      ),
    );

    expect(activeCounts).toEqual([1, 1, 1]);
    expect(startedAt[0]!).toBeLessThan(startedAt[1]!);
    expect(startedAt[1]!).toBeLessThan(startedAt[2]!);
  });

  it('T18: preserves order for 100 concurrent writes', async () => {
    const writes: number[] = [];
    const expected = Array.from({ length: 100 }, (_, i) => i);

    await Promise.all(
      expected.map((marker) =>
        withExplorerFileMutex(async () => {
          writes.push(marker);
          await Promise.resolve();
        }),
      ),
    );

    expect(writes).toEqual(expected);
  });

  it('T18: keeps the chain usable after a callback throws', async () => {
    await expect(
      withExplorerFileMutex(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(
      withExplorerFileMutex(async () => {
        return 'ok';
      }),
    ).resolves.toBe('ok');
  });

  it('T18: _resetExplorerFileMutex resets the chain for isolated tests', async () => {
    let releaseBlocker!: () => void;
    const blocker = withExplorerFileMutex(
      () =>
        new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        }),
    );

    let queuedRan = false;
    const queued = withExplorerFileMutex(async () => {
      queuedRan = true;
    });
    await Promise.resolve();
    expect(queuedRan).toBe(false);

    _resetExplorerFileMutex();
    let resetRan = false;
    await withExplorerFileMutex(async () => {
      resetRan = true;
    });
    expect(resetRan).toBe(true);
    expect(queuedRan).toBe(false);

    releaseBlocker();
    await blocker;
    await queued;
    expect(queuedRan).toBe(true);
  });
});
