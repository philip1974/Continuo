// 边界(E234,E216 并发 fan-out 同族):有界并发的 allSettled。
//
// `Promise.allSettled(items.map(fn))` 会**同时**发起 items.length 个异步任务 —— 当 items 由外部/畸形
// 数据驱动(marketplace index 上限 4096、本地插件目录上限 1024)时,数百到上千个 fetch/IO 同时在途会打出
// 网络/Promise/解析尖峰(GitHub raw 被本地 burst 打满、renderer 卡顿)。本 helper 用固定大小 worker 池把
// **最大同时在途数**钳定到 limit,同时保留 allSettled 语义(单个失败不影响其它、结果按输入顺序对位)。

/**
 * 以最多 `limit` 个并发运行 `fn`,返回与输入等长、按输入顺序对位的 PromiseSettledResult 数组。
 * 单个任务 reject 记为 {status:'rejected'},不影响其它任务(同 Promise.allSettled 语义)。
 * limit ≤ 0 视为 1(至少串行);limit ≥ items.length 时等价于全并发。
 */
export async function allSettledWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]!, i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  // 边界(E251,E248 clamp 非有限值族):limit 先归一化再算 worker 数。Math.max(1, Math.min(limit, len))
  // 对 limit=NaN 得 Math.max(1, NaN)=NaN → Array.from({length:NaN}) 生成 0 个 worker → 直接返回等长但
  // 全空洞的 results、一个任务都不执行(静默"成功"丢全部结果,违反 allSettled 语义)。非有限/≤0 视为 1。
  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 1;
  const workerCount = Math.min(safeLimit, items.length);
  const workers = new Array<Promise<void>>(workerCount);
  for (let i = 0; i < workerCount; i += 1) {
    workers[i] = worker();
  }
  await Promise.all(workers);
  return results;
}
