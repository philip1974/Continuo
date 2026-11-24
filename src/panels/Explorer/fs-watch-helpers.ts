// useFsWatcher 用到的纯函数。抽出来便于单测。

import { debounce, type DebouncedFn } from '@/lib/debounce';

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
  // 每个 path 一个 debounce 实例(含 maxWait 截止);触发后移除,下次同 path 重新开始一轮。
  const perPath = new Map<string, DebouncedFn<[]>>();

  const debounced = (path: string) => {
    let d = perPath.get(path);
    if (!d) {
      d = debounce(
        () => {
          perPath.delete(path);
          fn(path);
        },
        delayMs,
        maxWaitMs === undefined ? {} : { maxWait: maxWaitMs },
      );
      perPath.set(path, d);
    }
    d();
  };

  debounced.cancel = () => {
    for (const d of perPath.values()) d.cancel();
    perPath.clear();
  };

  return debounced as PerPathDebouncer;
}
