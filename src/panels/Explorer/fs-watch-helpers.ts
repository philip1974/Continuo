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
 */
export function makeDebouncePerPath(
  fn: (path: string) => void,
  delayMs: number,
): PerPathDebouncer {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const debounced = (path: string) => {
    const existing = timers.get(path);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      timers.delete(path);
      fn(path);
    }, delayMs);
    timers.set(path, t);
  };

  debounced.cancel = () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };

  return debounced as PerPathDebouncer;
}
