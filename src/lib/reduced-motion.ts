import { useEffect, useState } from 'react';

// 读取 prefers-reduced-motion: reduce 的 hook,供需要绕开 MotionConfig 的边角组件用。
// 全局动画短路靠 <MotionConfig reducedMotion="user">,这里只给装饰层做硬退化判断。
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
