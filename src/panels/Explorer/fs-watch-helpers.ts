// useFsWatcher 用到的纯函数。抽出来便于单测。

export interface SetDiff<T> {
  added: ReadonlySet<T>;
  removed: ReadonlySet<T>;
}

const EMPTY_DIFF_SET: ReadonlySet<never> = new Set();

/** 计算两个集合差异:next 比 prev 多/少哪些. */
export function diffSets<T>(
  prev: ReadonlySet<T>,
  next: ReadonlySet<T>,
): SetDiff<T> {
  if (prev === next) {
    return {
      added: EMPTY_DIFF_SET as ReadonlySet<T>,
      removed: EMPTY_DIFF_SET as ReadonlySet<T>,
    };
  }
  let added: Set<T> | null = null;
  let removed: Set<T> | null = null;
  for (const x of next) {
    if (!prev.has(x)) {
      added ??= new Set<T>();
      added.add(x);
    }
  }
  for (const x of prev) {
    if (!next.has(x)) {
      removed ??= new Set<T>();
      removed.add(x);
    }
  }
  return {
    added: added ?? (EMPTY_DIFF_SET as ReadonlySet<T>),
    removed: removed ?? (EMPTY_DIFF_SET as ReadonlySet<T>),
  };
}

export interface PerPathDebouncer {
  (path: string): void;
  cancel: () => void;
}

/**
 * 按 path 维度 debounce:同 path 在 delay 内多次触发只调最后一次,
 * 不同 path 互不影响。
 *
 * maxWaitMs(可选):纯 trailing debounce 在持续事件(如根目录持续写日志)下永不触发;给定时同 path
 * 自本轮首次触发起至多 maxWaitMs 必调一次(lodash maxWait 语义),之后开始新一轮。缺省 = 纯 trailing。
 */
export function makeDebouncePerPath(
  fn: (path: string) => void,
  delayMs: number,
  maxWaitMs?: number,
): PerPathDebouncer {
  // firstAt:本轮(上次调用 fn 之后)首次触发时刻,用于 maxWait 截止。
  const timers = new Map<string, { t: ReturnType<typeof setTimeout>; firstAt: number }>();

  const debounced = (path: string) => {
    const existing = timers.get(path);
    if (existing) clearTimeout(existing.t);
    const firstAt = existing?.firstAt ?? Date.now();
    const wait =
      maxWaitMs === undefined
        ? delayMs
        : Math.max(0, Math.min(delayMs, firstAt + maxWaitMs - Date.now()));
    const t = setTimeout(() => {
      timers.delete(path);
      fn(path);
    }, wait);
    timers.set(path, { t, firstAt });
  };

  debounced.cancel = () => {
    for (const e of timers.values()) clearTimeout(e.t);
    timers.clear();
  };

  return debounced as PerPathDebouncer;
}
