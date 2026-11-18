// 进程内异步读写锁:共享持有者可并行,独占持有者与任何其它持有者互斥。严格按到达顺序排队(FIFO)——
// 独占请求在等待时,后到的共享请求排在它后面,写者不会被源源不断的读者饿死。不可重入:持锁期间不得再
// 申请同一把锁(会死锁)。无超时:不会强行释放别人的锁。

export interface RwLock {
  /** 取共享锁运行 task;task 结束(含抛错)即释放。 */
  shared<T>(task: () => Promise<T> | T): Promise<T>;
  /** 取独占锁运行 task;task 结束(含抛错)即释放。 */
  exclusive<T>(task: () => Promise<T> | T): Promise<T>;
  /** 独占锁累计被授予的次数(只增)。两次读到同一个值 = 其间没有任何独占持有者开始运行。 */
  exclusiveGrants(): number;
  /** 此刻是否有独占持有者正在运行。 */
  isExclusiveHeld(): boolean;
}

export function createRwLock(): RwLock {
  let readers = 0;
  let writing = false;
  let grants = 0;
  const queue: { exclusive: boolean; grant: () => void }[] = [];

  const drain = (): void => {
    for (;;) {
      const head = queue[0];
      if (!head || writing || (head.exclusive && readers > 0)) return;
      queue.shift();
      if (head.exclusive) {
        writing = true;
        grants += 1;
      } else readers += 1;
      head.grant();
    }
  };

  const run = async <T>(exclusive: boolean, task: () => Promise<T> | T): Promise<T> => {
    await new Promise<void>((grant) => {
      queue.push({ exclusive, grant });
      drain();
    });
    try {
      return await task();
    } finally {
      if (exclusive) writing = false;
      else readers -= 1;
      drain();
    }
  };

  return {
    shared: (task) => run(false, task),
    exclusive: (task) => run(true, task),
    exclusiveGrants: () => grants,
    isExclusiveHeld: () => writing,
  };
}
