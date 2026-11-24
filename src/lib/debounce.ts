export interface DebouncedFn<A extends unknown[]> {
  (...args: A): void;
  /** race(R22):取消未触发的 pending 调用(组件卸载/重建时清理,防迟到回调对旧实例生效)。 */
  cancel: () => void;
}

export interface DebounceOptions {
  /**
   * 纯 trailing debounce 在持续事件下永不触发;给定时自本轮(上次执行 / cancel 之后)首次调用起至多 maxWait
   * 必执行一次(lodash maxWait 语义),之后开始新一轮。缺省 = 纯 trailing。
   */
  readonly maxWait?: number;
}

/** 尾随防抖:连续调用只在最后一次之后 delay 执行一次,参数取最后一次。 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number,
  opts: DebounceOptions = {},
): DebouncedFn<A> {
  const { maxWait } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt: number | undefined; // 本轮首次调用时刻(maxWait 截止用)
  const debounced = ((...args: A) => {
    if (timer) clearTimeout(timer);
    let wait = delay;
    if (maxWait !== undefined) {
      const now = Date.now();
      firstAt ??= now;
      wait = Math.max(0, Math.min(delay, firstAt + maxWait - now));
    }
    timer = setTimeout(() => {
      timer = undefined;
      firstAt = undefined;
      fn(...args);
    }, wait);
  }) as DebouncedFn<A>;
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    firstAt = undefined;
  };
  return debounced;
}
