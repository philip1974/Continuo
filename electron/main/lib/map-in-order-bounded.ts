/**
 * 以最多 `limit` 个并发对 items 运行 fn,结果按输入顺序对位。任一 fn reject → 整体 reject(其余在跑的
 * worker 照常跑完当前项后继续领取);可预期错误由 fn 自行吞掉(返回 null 等)。
 * 插件目录列举 / watcher 轮询、path-scope 规范化、scope 请求节流键的 stat 共用(此前各写一份 worker 池)。
 * renderer 的 src/lib/map-with-concurrency 是 allSettled 语义,不同。
 */
export async function mapInOrderBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]!);
    }
  };
  const workerCount = Math.min(limit, items.length);
  const workers = new Array<Promise<void>>(workerCount);
  for (let i = 0; i < workerCount; i += 1) workers[i] = worker();
  await Promise.all(workers);
  return results;
}
