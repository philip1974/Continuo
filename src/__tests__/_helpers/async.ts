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
