// 测试共享 helper:异步控制原语。
// tsconfig lib 为 ES2022,不能用 Promise.withResolvers,这里手写等价实现。

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** 外部可控的 Promise:测试里用它挂起某个异步步骤,再按需 resolve / reject。 */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 连续 await `rounds` 轮 `Promise.resolve()`,冲刷微任务链。 */
export async function flushMicrotasks(rounds = 1): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/**
 * 连续等待 `rounds` 个宏任务(`setTimeout(r, 0)` 或 `setImmediate(r)`)。
 * 单轮直接返回那一个 Promise(不包一层 async),与手写的 `() => new Promise((r) => setTimeout(r, 0))` 等价;
 * 多轮与手写的 `for (...) await new Promise(...)` 循环等价。
 * 计时器在调用时从全局读取,假计时器下同样被接管 —— 调用方须自行确认这是想要的。
 */
export function flushMacrotasks(rounds = 1, via: 'timeout' | 'immediate' = 'timeout'): Promise<void> {
  const once = (): Promise<void> =>
    new Promise<void>((r) => (via === 'timeout' ? setTimeout(r, 0) : setImmediate(r)));
  if (rounds === 1) return once();
  return (async () => {
    for (let i = 0; i < rounds; i++) await once();
  })();
}
