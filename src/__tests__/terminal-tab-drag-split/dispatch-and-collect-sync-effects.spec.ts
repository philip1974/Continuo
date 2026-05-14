/**
 * P0-2: useDispatchWithEffects 新 `dispatchAndCollect` helper 同步返回该次 action
 * 产生的 effects(不进 effectQueueRef)。让 PaneController.detachTab 同步拿
 * leafSnapshot 而不依赖 React effect flush 时序。
 */
import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDispatchWithEffects } from '../../panels/Terminal/useDispatchWithEffects';

type S = { value: number };
type A = { type: 'add'; by: number } | { type: 'reset' };
type E = { type: 'changed'; from: number; to: number };

function reducer(state: S, action: A): { state: S; effects: E[] } {
  if (action.type === 'add') {
    const next = { value: state.value + action.by };
    return { state: next, effects: [{ type: 'changed', from: state.value, to: next.value }] };
  }
  return { state: { value: 0 }, effects: [{ type: 'changed', from: state.value, to: 0 }] };
}

describe('terminal-tab-drag-split: dispatchAndCollect sync effects', () => {
  it('returns effects synchronously and does NOT push them to effectQueueRef', () => {
    const { result } = renderHook(() => useDispatchWithEffects(reducer, { value: 10 }));
    let collected: E[] = [];
    act(() => {
      collected = result.current.dispatchAndCollect({ type: 'add', by: 5 });
    });
    expect(collected).toEqual([{ type: 'changed', from: 10, to: 15 }]);
    // 关键:effects 没有进 effectQueueRef(plan-v2 P0-2 invariant)
    expect(result.current.effectQueueRef.current).toEqual([]);
    // state 已 sync 更新
    expect(result.current.state.value).toBe(15);
  });

  it('dispatch (legacy) still pushes effects to effectQueueRef', () => {
    const { result } = renderHook(() => useDispatchWithEffects(reducer, { value: 0 }));
    act(() => {
      result.current.dispatch({ type: 'add', by: 1 });
    });
    expect(result.current.effectQueueRef.current).toEqual([
      { type: 'changed', from: 0, to: 1 },
    ]);
  });

  it('dispatch and dispatchAndCollect do not cross-contaminate', () => {
    const { result } = renderHook(() => useDispatchWithEffects(reducer, { value: 0 }));
    act(() => {
      result.current.dispatch({ type: 'add', by: 2 });
      const sync = result.current.dispatchAndCollect({ type: 'add', by: 3 });
      expect(sync).toEqual([{ type: 'changed', from: 2, to: 5 }]);
    });
    // queue 只有 legacy dispatch 派的那一条
    expect(result.current.effectQueueRef.current).toEqual([
      { type: 'changed', from: 0, to: 2 },
    ]);
    expect(result.current.state.value).toBe(5);
  });
});
