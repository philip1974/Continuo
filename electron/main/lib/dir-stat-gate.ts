import * as fs from 'node:fs';

// 性能(第 6 轮审计):fs.promises 全部跑在 libuv 线程池(默认 4 线程)。目录存在性判定指向失联 /
// 休眠挂载点时单次 stat 可卡数秒,在途 ≥4 即占满线程池,所有 fs.promises(保存、listDir、持久化)
// 跟着排队。三处「目录判定 stat」(open-file / 新窗口打开文件夹 / 启动恢复)共用这一个全局闸,
// 最多占一半线程,其余留给正常文件 I/O。

export interface Semaphore {
  /**
   * 拿到名额后执行 fn,结束(成功 / 失败 / 同步抛错)即释放;按调用顺序 FIFO 放行。
   * maxWaitMs:排队超过该时长仍未拿到名额 → 离队,改去 overflow 排队(两闸交替,任一空出即执行;未给
   * overflow 则直接执行)。fs.promises.stat 不可取消,指向失联挂载点的 stat 可能永不返回;没有上限时它们长期占住
   * 名额,本地健康路径(用户点「在新窗口打开文件夹」)会被无限期排在后面。overflow 再给离队者设容量上限,
   * 防 N 个同时离队者一齐绕过闸门、重新占满线程池。
   */
  run<T>(fn: () => Promise<T>, maxWaitMs?: number, overflow?: Semaphore): Promise<T>;
}

export function createSemaphore(capacity: number): Semaphore {
  let active = 0;
  // 等待者被唤醒即**接手**释放者的名额(active 不变),故不会被新来者插队。
  const waiters: Array<() => void> = [];
  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  };
  /** 排队;resolve(true)=接手名额,resolve(false)=等待超时已离队(不占名额)。 */
  const wait = (maxWaitMs: number | undefined): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onSlot = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(true);
      };
      waiters.push(onSlot);
      if (maxWaitMs !== undefined) {
        timer = setTimeout(() => {
          // 同一线程内交接与超时互斥:能在队列里找到自己 = 尚未被交接名额。
          const i = waiters.indexOf(onSlot);
          if (i === -1) return;
          waiters.splice(i, 1);
          resolve(false);
        }, maxWaitMs);
      }
    });
  const self: Semaphore = {
    async run<T>(fn: () => Promise<T>, maxWaitMs?: number, overflow?: Semaphore): Promise<T> {
      let holding = true;
      if (active < capacity) active += 1;
      else holding = await wait(maxWaitMs);
      // 离队 → 转去 overflow 排队,并以本闸作为它的 overflow:两闸交替排队(每段最多 maxWaitMs),
      // 任一闸先空出名额即执行。否则离队者被钉在 overflow 上 —— overflow 被卡死时,本闸早已空出
      // 也不回流,判定永远不结束。fn 只在持有某个名额时执行,总在途上限不变。
      if (!holding && overflow) return overflow.run(fn, maxWaitMs, self);
      try {
        return await fn();
      } finally {
        if (holding) release();
      }
    },
  };
  return self;
}

export const DIR_STAT_CONCURRENCY = 2;
/** 目录判定排队上限:健康 stat 毫秒级返回,排满 2s 说明名额被慢 / 失联挂载占住。 */
export const DIR_STAT_MAX_WAIT_MS = 2000;

const dirStatGate = createSemaphore(DIR_STAT_CONCURRENCY);
// 超时离队者的溢出通道:总在途 ≤ DIR_STAT_CONCURRENCY + 1 = 3,始终给 libuv 默认 4 线程留 1 个做其它 fs I/O。
// 离队者在两闸之间交替排队(见 Semaphore.run),不直接执行:3 个 stat 同时卡死时健康判定只能等,这是 stat
// 不可取消下的取舍——宁可目录判定慢,也不让保存 / listDir / 持久化一起饿死;任一闸空出即回流完成。
const dirStatOverflow = createSemaphore(1);

/** 经全局并发闸的 fs.promises.stat;结果与错误原样透传(调用方自行判定 isDirectory / 错误码)。 */
export function statDirGated(p: string): Promise<fs.Stats> {
  return dirStatGate.run(() => fs.promises.stat(p), DIR_STAT_MAX_WAIT_MS, dirStatOverflow);
}
