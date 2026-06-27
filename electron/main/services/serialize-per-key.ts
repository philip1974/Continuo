// race(R17):按 key 串行化异步任务的通用工具。把任务接到该 key 的 Promise 链尾,保证按调用
// 顺序依次执行 —— 用于「连续异步操作不 await 会乱序完成」的场景(如 PTY resize:较早的小尺寸
// 若晚于较新的大尺寸完成会回退 PTY 行列数)。链尾吞掉每个任务的成功/失败结果,使前一个任务
// 失败不阻断后续(每个任务自行用 onError 处理异常)。
//
// 与 IpcPermissionStore.runExclusive(R15)同型,但这里是 fire-and-forget(不返回结果给调用方),
// 适合主进程「最新一次自然最后生效」的 last-wins 语义。

export function serializePerKey(
  chains: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<void>,
): void {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(() =>
    task().then(
      () => undefined,
      () => undefined,
    ),
  );
  chains.set(key, next);
  // race(R100):链排空且仍是尾部 → 删条目。否则 chains 随用过的 key 单调增长 —— 已完成的串行
  // 锁条目永不回收,长会话(大量 key)下形成并发控制 Map 的内存泄漏(同 atomic-write.ts
  // withPathLock 的清理)。新任务在 cleanup 微任务前入队会把 chains.get(key) 换成新尾,!==next
  // → 不删,保持锁链完整。
  void next.then(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
}

// 同 serializePerKey,但**返回本次任务的真实结果/异常**(调用方据此做后续,如安装 swap 的返回值)。
// 串行语义、链尾吞错、排空回收(R100)全一致。主进程内多处「同 key 串行 + 要结果」的并发锁
// (withInstallLock 等)此前各写一份 inline 副本,易漏排空回收(R100/R101 根因)→ 收口到此。
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
  // race(R100/R101):链排空且仍是尾部 → 删条目,防 Map 随用过的 key 单调增长(内存泄漏)。
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return result;
}
