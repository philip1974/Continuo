// perf(r-fresh #6):outermostPaths / 剪贴板 prune 不得做两两 isSameOrInsidePath 比较
//(5000 个互不包含路径 → ~2500 万次)。以 isSameOrInsidePath 调用次数为代价指标锁定上界。
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('@/lib/path-cross', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/path-cross')>();
  return {
    ...mod,
    isSameOrInsidePath: (a: string, b: string) => {
      calls.n += 1;
      return mod.isSameOrInsidePath(a, b);
    },
  };
});

import { outermostPaths } from '@/panels/Explorer/path-utils';
import { pruneClipboardPaths } from '@/panels/Explorer/clipboard-store';

const N = 2000;
const paths = Array.from({ length: N }, (_, i) => `/ws/d${i % 50}/f${i}.ts`);

describe('批量路径包含判断的复杂度', () => {
  it('outermostPaths 不做 N² 两两比较', () => {
    calls.n = 0;
    expect(outermostPaths(paths)).toHaveLength(N);
    expect(calls.n).toBeLessThan(N * 4);
  });

  it('pruneClipboardPaths 不做 clipboard × removed 两两比较', () => {
    calls.n = 0;
    const removed = paths.filter((_, i) => i % 2 === 0);
    expect(pruneClipboardPaths(paths, removed)).toHaveLength(N / 2);
    expect(calls.n).toBeLessThan(N * 4);
  });
});
