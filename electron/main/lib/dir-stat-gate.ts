import * as fs from 'node:fs';

// 性能(第 6 轮审计):fs.promises 全部跑在 libuv 线程池(默认 4 线程)。目录存在性判定指向失联 /
// 休眠挂载点时单次 stat 可卡数秒,在途 ≥4 即占满线程池,所有 fs.promises(保存、listDir、持久化)
// 跟着排队。三处「目录判定 stat」(open-file / 新窗口打开文件夹 / 启动恢复)共用这一个全局闸,
// 最多占一半线程,其余留给正常文件 I/O。

export interface Semaphore {
  /** 拿到名额后执行 fn,结束(成功 / 失败 / 同步抛错)即释放;按调用顺序 FIFO 放行。 */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSemaphore(capacity: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];
  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < capacity) active += 1;
      else await new Promise<void>((resolve) => waiters.push(resolve));
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

export const DIR_STAT_CONCURRENCY = 2;

const dirStatGate = createSemaphore(DIR_STAT_CONCURRENCY);

/** 经全局并发闸的 fs.promises.stat;结果与错误原样透传(调用方自行判定 isDirectory / 错误码)。 */
export function statDirGated(p: string): Promise<fs.Stats> {
  return dirStatGate.run(() => fs.promises.stat(p));
}
