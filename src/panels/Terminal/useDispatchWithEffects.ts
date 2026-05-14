import { useCallback, useRef, useState } from 'react';

export function useDispatchWithEffects<S, A, E>(
  reducer: (state: S, action: A) => { state: S; effects: E[] },
  initialState: S,
) {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  const effectQueueRef = useRef<E[]>([]);
  const [effectTrigger, setEffectTrigger] = useState(0);

  const dispatch = useCallback(
    (action: A) => {
      const result = reducer(stateRef.current, action);
      stateRef.current = result.state;
      setState(result.state);
      if (result.effects.length > 0) {
        effectQueueRef.current.push(...result.effects);
        setEffectTrigger((n) => n + 1);
      }
    },
    [reducer],
  );

  return { state, stateRef, dispatch, effectQueueRef, effectTrigger };
}
