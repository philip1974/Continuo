// 按 key 串行化异步任务并**返回本次任务的真实结果/异常**的跨进程单一来源(重构:renderer
// src/lib/serialize-per-key.ts 与 main electron/main/services/serialize-per-key.ts 此前各持一份
// 逐字相同的实现;race R15/R21 提炼,R100/R101 排空回收)。
//
// 任务接到该 key 的 Promise 链尾,按调用顺序依次执行;前一个任务成功或失败都不阻断后续
// (prev.then(task, task));链尾吞错。用于「同一资源的多个异步写不可乱序完成」(同一 editor tab
// 的 autosave 与手动 save、同一 plugin 的 install swap、PluginDataStore 写链等)。

export function runSerialPerKey<T>(
  chains: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const result = prev.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  // race(R100/R101):链排空且仍是尾部 → 删条目,防 Map 随用过的 key 单调增长(内存泄漏;同
  // atomic-write.ts withPathLock 的清理)。新任务在 cleanup 微任务前入队会把 chains.get(key) 换成
  // 新尾,!==settled → 不删,保持链完整。
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return result;
}

export interface SerialQueue {
  /** 接到队尾执行并返回本次任务的真实结果/异常;前一个任务失败不阻断后续。 */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** 丢弃对在途任务的排队关系(测试隔离用)。 */
  reset(): void;
}

/**
 * 单条全局串行队列(runSerialPerKey 的无 key 版):同一资源(一个 JSON 文件)的 read-modify-write
 * 必须整段串行,否则并发写者各读旧快照、整表写回 → lost update。主进程各持久化文件
 * (_enabled / _permissions / _plugin-path-scopes / settings / explorer.json)此前各手写一条
 * `let chain = Promise.resolve()` + `chain = run.then(noop, noop)`。
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    reset(): void {
      tail = Promise.resolve();
    },
  };
}
