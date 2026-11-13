// @vitest-environment jsdom
// BDD:定时轮询外部快照。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { usePolledSnapshot } from '../../lib/use-polled-snapshot';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

describe('usePolledSnapshot', () => {
  it('内容相同 → 保持原引用;内容变化 → 换新值', () => {
    let source: readonly string[] = ['a'];
    const { result } = renderHook(() => usePolledSnapshot(() => [...source], sameList));
    const first = result.current[0];
    expect(first).toEqual(['a']);

    act(() => void vi.advanceTimersByTime(3000)); // 每次 read 都是新数组,但内容相同
    expect(result.current[0]).toBe(first);

    source = ['a', 'b'];
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current[0]).toEqual(['a', 'b']);
  });

  it('refresh() 立即读取,且引用稳定', () => {
    let source: readonly string[] = [];
    const { result, rerender } = renderHook(() => usePolledSnapshot(() => [...source], sameList));
    const refresh = result.current[1];
    source = ['x'];
    act(() => refresh());
    expect(result.current[0]).toEqual(['x']);
    rerender();
    expect(result.current[1]).toBe(refresh);
  });

  it('卸载后停止轮询', () => {
    const read = vi.fn(() => 1);
    const { unmount } = renderHook(() => usePolledSnapshot(read, Object.is));
    unmount();
    const calls = read.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(read.mock.calls.length).toBe(calls);
  });
});
