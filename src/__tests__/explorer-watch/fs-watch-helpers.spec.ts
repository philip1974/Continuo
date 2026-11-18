import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  diffSets,
  makeDebouncePerPath,
} from '../../panels/Explorer/fs-watch-helpers';

describe('diffSets', () => {
  it('计算 added / removed', () => {
    const prev = new Set(['/a', '/b', '/c']);
    const next = new Set(['/b', '/c', '/d']);
    const r = diffSets(prev, next);
    expect(r.added).toEqual(new Set(['/d']));
    expect(r.removed).toEqual(new Set(['/a']));
  });

  it('全部新增', () => {
    const r = diffSets(new Set(), new Set(['/x', '/y']));
    expect(r.added).toEqual(new Set(['/x', '/y']));
    expect(r.removed.size).toBe(0);
  });

  it('全部移除', () => {
    const r = diffSets(new Set(['/x', '/y']), new Set());
    expect(r.added.size).toBe(0);
    expect(r.removed).toEqual(new Set(['/x', '/y']));
  });

  it('完全相同 → 都为空', () => {
    const s = new Set(['/x']);
    const r = diffSets(s, s);
    expect(r.added.size).toBe(0);
    expect(r.removed.size).toBe(0);
  });

  it('无差异/单侧为空时复用稳定空 Set', () => {
    const same = new Set(['/x']);
    const empty = diffSets(same, same).added;

    expect(diffSets(new Set(['/x']), new Set(['/x'])).added).toBe(empty);
    expect(diffSets(new Set(['/x']), new Set(['/x'])).removed).toBe(empty);
    expect(diffSets(new Set(), new Set(['/x'])).removed).toBe(empty);
    expect(diffSets(new Set(['/x']), new Set()).added).toBe(empty);
  });
});

describe('makeDebouncePerPath', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('同 path 多次触发 → debounce 只调最后一次', () => {
    const fn = vi.fn();
    const debounced = makeDebouncePerPath(fn, 100);
    debounced('/a');
    debounced('/a');
    debounced('/a');
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('/a');
  });

  it('不同 path 互不影响', () => {
    const fn = vi.fn();
    const debounced = makeDebouncePerPath(fn, 100);
    debounced('/a');
    debounced('/b');
    debounced('/c');
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls.map((c) => c[0])).toEqual(['/a', '/b', '/c']);
  });

  it('cancel() 清掉所有 pending,fn 不再调', () => {
    const fn = vi.fn();
    const debounced = makeDebouncePerPath(fn, 100);
    debounced('/a');
    debounced('/b');
    debounced.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  // 性能:纯 trailing debounce 在持续事件下永不触发;maxWait 保证同 path 至多 maxWait 调一次。
  it('maxWait:持续触发下自本轮首次触发起至多 maxWait 调一次,之后开始新一轮', () => {
    const fn = vi.fn();
    const debounced = makeDebouncePerPath(fn, 100, 1000);
    for (let i = 0; i < 20; i++) {
      debounced('/a');
      vi.advanceTimersByTime(50);
    }
    // t=1000 时触发一次(本轮首次在 t=0,最后一次触发在 t=950)
    expect(fn).toHaveBeenCalledTimes(1);
    debounced('/a'); // 新一轮:恢复普通 trailing
    vi.advanceTimersByTime(99);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('maxWait:稀疏触发时行为与纯 trailing 一致;未给 maxWait 的持续触发仍只在停止后调一次', () => {
    const fn = vi.fn();
    const withMax = makeDebouncePerPath(fn, 100, 1000);
    withMax('/a');
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);

    const g = vi.fn();
    const plain = makeDebouncePerPath(g, 100);
    for (let i = 0; i < 40; i++) {
      plain('/a');
      vi.advanceTimersByTime(50);
    }
    expect(g).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('cancel 后再触发仍工作', () => {
    const fn = vi.fn();
    const debounced = makeDebouncePerPath(fn, 100);
    debounced('/a');
    debounced.cancel();
    debounced('/b');
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('/b');
  });
});
