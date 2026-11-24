import * as fs from 'node:fs';

// 性能(第 6 轮审计):fs.promises 全部跑在 libuv 线程池(默认 4 线程)。目录存在性判定指向失联 /
// 休眠挂载点时单次 stat 可卡数秒,在途 ≥4 即占满线程池,所有 fs.promises(保存、listDir、持久化)
// 跟着排队。各处「目录判定 stat」(open-file / 新窗口打开文件夹 / 启动恢复 / 新建终端 cwd)共用这一个全局闸,
// 最多占一半线程,其余留给正常文件 I/O。

export interface Semaphore {
  /**
   * 拿到名额后执行 fn,结束(成功 / 失败 / 同步抛错)即释放;按调用顺序 FIFO 放行。
   * maxWaitMs:排队超过该时长仍未拿到名额 → 离队(未给 overflow 则不占名额直接执行)。给了 overflow 时
   * 不离开本闸队列,而是**同时**在 overflow 登记,先被交接名额的一方胜出、另一方撤销登记:任一闸空出即
   * 执行,总在途 ≤ 两闸容量之和,且不随等待时长增长计时器 / Promise 链。
   * fs.promises.stat 不可取消,指向失联挂载点的 stat 可能永不返回;没有上限时它们长期占住名额,本地健康
   * 路径(用户点「在新窗口打开文件夹」)会被无限期排在后面;overflow 再给离队者设容量上限,防 N 个同时
   * 离队者一齐绕过闸门、重新占满线程池。
   */
  run<T>(fn: () => Promise<T>, maxWaitMs?: number, overflow?: Semaphore): Promise<T>;
}

/** 等待者:被交接名额时调用,返回是否接受(已在另一闸胜出 → 拒绝,名额继续往下交)。 */
type Waiter = () => boolean;

interface Gate {
  tryAcquire(): boolean;
  enqueue(w: Waiter): () => void;
  release(): void;
}

const gates = new WeakMap<Semaphore, Gate>();

function createGate(capacity: number): Gate {
  let active = 0;
  const waiters: Waiter[] = [];
  return {
    tryAcquire() {
      if (active < capacity) {
        active += 1;
        return true;
      }
      return false;
    },
    enqueue(w) {
      waiters.push(w);
      return () => {
        const i = waiters.indexOf(w);
        if (i !== -1) waiters.splice(i, 1);
      };
    },
    // 等待者接受即**接手**释放者的名额(active 不变),故不会被新来者插队。
    release() {
      while (waiters.length > 0) {
        if (waiters.shift()!()) return;
      }
      active -= 1;
    },
  };
}

/** 排队取名额:resolve 拿到名额的闸;null = 无 overflow 且等待超时(不占名额)。 */
function acquire(
  primary: Gate,
  maxWaitMs: number | undefined,
  overflow: Gate | undefined,
): Promise<Gate | null> {
  if (primary.tryAcquire()) return Promise.resolve(primary);
  return new Promise<Gate | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelOverflow: (() => void) | undefined;
    const win = (gate: Gate | null): boolean => {
      if (settled) return false;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      cancelPrimary();
      cancelOverflow?.();
      resolve(gate);
      return true;
    };
    const cancelPrimary = primary.enqueue(() => win(primary));
    if (maxWaitMs === undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (settled) return;
      if (!overflow) {
        win(null);
        return;
      }
      // 不离开主闸队列,同时在溢出闸登记;溢出闸当前空闲则直接拿。
      if (overflow.tryAcquire()) {
        if (!win(overflow)) overflow.release();
        return;
      }
      cancelOverflow = overflow.enqueue(() => win(overflow));
    }, maxWaitMs);
  });
}

export function createSemaphore(capacity: number): Semaphore {
  const gate = createGate(capacity);
  const self: Semaphore = {
    async run<T>(fn: () => Promise<T>, maxWaitMs?: number, overflow?: Semaphore): Promise<T> {
      const held = await acquire(gate, maxWaitMs, overflow ? gates.get(overflow) : undefined);
      try {
        return await fn();
      } finally {
        held?.release();
      }
    },
  };
  gates.set(self, gate);
  return self;
}

export const DIR_STAT_CONCURRENCY = 2;
/** 目录判定排队上限:健康 stat 毫秒级返回,排满 2s 说明名额被慢 / 失联挂载占住。 */
export const DIR_STAT_MAX_WAIT_MS = 2000;

const dirStatGate = createSemaphore(DIR_STAT_CONCURRENCY);
// 超时离队者的溢出通道:总在途 ≤ DIR_STAT_CONCURRENCY + 1 = 3,始终给 libuv 默认 4 线程留 1 个做其它 fs I/O。
// 离队者同时在两闸排队(见 Semaphore.run),不直接执行:3 个 stat 同时卡死时健康判定只能等,这是 stat
// 不可取消下的取舍——宁可目录判定慢,也不让保存 / listDir / 持久化一起饿死;任一闸空出即立即接手。
const dirStatOverflow = createSemaphore(1);

/** 经全局并发闸的 fs.promises.stat;结果与错误原样透传(调用方自行判定 isDirectory / 错误码)。 */
export function statDirGated(p: string): Promise<fs.Stats> {
  return dirStatGate.run(() => fs.promises.stat(p), DIR_STAT_MAX_WAIT_MS, dirStatOverflow);
}
