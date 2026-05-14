import { useRef, useState } from 'react';

export function useDispatchWithEffects<S, A, E>(
  reducer: (state: S, action: A) => { state: S; effects: E[] },
  initialState: S,
) {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  const effectQueueRef = useRef<E[]>([]);
  const [effectTrigger, setEffectTrigger] = useState(0);
  // dispatch 用 ref 持稳定 identity:React 19 StrictMode 在 dev mount → unmount → remount
  // 时,useCallback 返回新 fn → 触发依赖它的 useMemo(spawnQueue)cleanup,把已派出的
  // spawn 标 cancelled,但 remount 后 effect runner 因 effectTrigger 不变不会再 enqueue,
  // 导致 ptyId 永远填不回来。改 ref 后 dispatch identity 跨 mount 稳定,spawnQueue 不
  // 被 re-create,cleanup 也只在真 unmount 时跑。
  const dispatchRef = useRef<(action: A) => void>(null as unknown as (action: A) => void);
  if (dispatchRef.current === null) {
    dispatchRef.current = (action: A) => {
      const result = reducer(stateRef.current, action);
      stateRef.current = result.state;
      setState(result.state);
      if (result.effects.length > 0) {
        effectQueueRef.current.push(...result.effects);
        setEffectTrigger((n) => n + 1);
      }
    };
  }

  // dispatchAndCollect: 同步跑 reducer + 同步返回 effects（不进 effectQueueRef）。
  // 让 caller(如 PaneController.detachTab)拿到本次 action 的 effects 后直接消费,
  // 不依赖 React effect flush 的异步时序。state 仍然同步更新(setState + stateRef)。
  const dispatchAndCollectRef = useRef<(action: A) => E[]>(null as unknown as (action: A) => E[]);
  if (dispatchAndCollectRef.current === null) {
    dispatchAndCollectRef.current = (action: A) => {
      const result = reducer(stateRef.current, action);
      stateRef.current = result.state;
      setState(result.state);
      return result.effects;
    };
  }

  return {
    state,
    stateRef,
    dispatch: dispatchRef.current,
    dispatchAndCollect: dispatchAndCollectRef.current,
    effectQueueRef,
    effectTrigger,
  };
}
