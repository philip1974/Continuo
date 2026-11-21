export interface DebouncedFn<A extends unknown[]> {
  (...args: A): void;
  /** race(R22):取消未触发的 pending 调用(组件卸载/重建时清理,防迟到回调对旧实例生效)。 */
  cancel: () => void;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): DebouncedFn<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = ((...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as DebouncedFn<A>;
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return debounced;
}
