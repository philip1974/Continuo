// 引用恒定、调用时转发到最新 fn 的回调(latest-ref)。用于传给以回调为 effect 依赖的组件:design Modal 的
// 焦点 / 键盘栈 effect 依赖 onClose,调用方传内联回调时每次重渲都会 cleanup 再重跑 → 焦点被拉回、键盘栈重排。
import { useCallback, useRef } from 'react';

export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
