// 「按 key 分组、组的顺序 = 首次出现顺序、组内保持原顺序」的 renderer 单一来源。
// 设置搜索结果 / 设置分类页 / 快捷键页 / Explorer 右键菜单此前各手写一份(同一骨架,只差 key 函数)。
//
// 这些列表都在渲染路径上且绝大多数时候只有一个组,所以保留两条省分配的路径:
//  - 全部同 key(含单项)→ 直接复用入参数组(owned=false,调用方不得原地改);
//  - 否则每组按入参长度预分配、最后截断(不逐项 push 扩容),owned=true(调用方可原地排序)。

export interface KeyedGroup<K, T> {
  readonly key: K;
  readonly items: readonly T[];
  /** true = items 是本次新分配的数组,可原地排序;false = 就是入参数组本身。 */
  readonly owned: boolean;
}

export function groupKeepingOrder<T, K>(
  items: readonly T[],
  keyOf: (item: T) => K,
): KeyedGroup<K, T>[] {
  if (items.length === 0) return [];
  const firstKey = keyOf(items[0]!);
  let allSameKey = true;
  for (let i = 1; i < items.length; i++) {
    if (keyOf(items[i]!) !== firstKey) {
      allSameKey = false;
      break;
    }
  }
  if (allSameKey) return [{ key: firstKey, items, owned: false }];

  const map = new Map<K, { items: T[]; count: number }>();
  for (const item of items) {
    const key = keyOf(item);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { items: new Array<T>(items.length), count: 0 };
      map.set(key, bucket);
    }
    bucket.items[bucket.count++] = item;
  }
  const groups = new Array<KeyedGroup<K, T>>(map.size);
  let i = 0;
  for (const [key, bucket] of map) {
    bucket.items.length = bucket.count;
    groups[i++] = { key, items: bucket.items, owned: true };
  }
  return groups;
}
