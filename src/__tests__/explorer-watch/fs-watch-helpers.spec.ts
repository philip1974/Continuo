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
