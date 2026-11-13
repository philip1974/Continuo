/**
 * 按谓词过滤、尽量不分配:
 *   - 全部通过 → 原样返回入参数组(保持引用,memo / zustand 订阅友好);
 *   - 首个被滤掉的项出现时才惰性拷贝前缀;
 *   - 全被滤掉 → 返回调用方给的共享空数组 `empty`(稳定引用)。
 * 每项只调一次谓词。registry 的 filterVisible、通知列表按 id 移除、scope 授权弹窗队列按 id 移除共用
 * (此前三处各手写同一算法)。
 */
export function filterKeepingIdentity<T, A extends readonly T[] = T[]>(
  items: readonly T[],
  keep: (item: T) => boolean,
  empty: A,
): A {
  let out: T[] | null = null;
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (!keep(item)) {
      if (out === null) {
        out = new Array<T>(items.length);
        for (let j = 0; j < i; j++) out[j] = items[j]!;
        count = i;
      }
      continue;
    }
    if (out !== null) out[count++] = item;
  }
  if (out === null) return items as unknown as A;
  out.length = count;
  return count === 0 ? empty : (out as unknown as A);
}
