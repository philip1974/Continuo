// 按 key 计数:减到 0 即删 key(Map 排空回收,防计数项泄漏),O(1) 维护各 key 计数与总数。
// 用于 per-wc / per-window / per-sender 的在途数、引用计数等上限判定。

export interface KeyedCounter<K> {
  /** 计数 +1。 */
  inc(key: K): void;
  /** 计数 -1,归零删 key;key 不存在为 no-op(不出现负数)。 */
  dec(key: K): void;
  /** 当前计数(不存在为 0)。 */
  get(key: K): number;
  /** 计数 > 0。 */
  has(key: K): boolean;
  /** 计数 > 0 的 key(活视图,不复制)。 */
  keys(): IterableIterator<K>;
  /** 删整个 key(计数清零)。 */
  delete(key: K): void;
  /** 各 key 计数之和。 */
  total(): number;
  clear(): void;
}

export function createKeyedCounter<K>(): KeyedCounter<K> {
  const counts = new Map<K, number>();
  let total = 0;
  return {
    inc(key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    },
    dec(key) {
      const n = counts.get(key);
      if (n === undefined) return;
      total -= 1;
      if (n > 1) counts.set(key, n - 1);
      else counts.delete(key);
    },
    get: (key) => counts.get(key) ?? 0,
    has: (key) => counts.has(key),
    keys: () => counts.keys(),
    delete(key) {
      total -= counts.get(key) ?? 0;
      counts.delete(key);
    },
    total: () => total,
    clear() {
      counts.clear();
      total = 0;
    },
  };
}
