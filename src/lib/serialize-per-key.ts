// race(R21):按 key 串行化异步任务并**返回结果**的工具(R15 IpcPermissionStore.runExclusive
// 的通用提炼,renderer 版)。任务接到该 key 的 Promise 链尾,按调用顺序依次执行,调用方仍拿到
// 本次任务的真实结果/异常。用于「同一资源的多个异步写不可乱序完成」的场景(如同一 editor tab
// 的 autosave 与手动 save 并发:必须保证按发起顺序落盘,最后发起的内容最后落盘)。
//
// 与 electron/main 的 serializePerKey(R17,fire-and-forget,不返回结果)区别:此版返回结果,
// 供调用方据此做后续(如 markSaved)。链尾吞掉成功/失败,前一个任务失败不阻断后续。

export function runSerialPerKey<T>(
  chains: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // 无论前一个任务成功或失败,本次都执行(prev.then(task, task) 两分支同 task)。
  const result = prev.then(task, task);
  // 链尾吞错,使后续任务不被前一次 reject 中断。
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  // race(R100):链排空且仍是尾部 → 删条目。否则 chains 随用过的 key 单调增长(editor
  // saveChains 按 tabId、PluginDataStore writeChains 按 pluginId)—— 已完成的串行锁条目永不
  // 回收,长会话/大量打开保存文件后形成内存泄漏(同 atomic-write.ts withPathLock 的清理)。
  // 新任务在 cleanup 微任务前入队会把 chains.get(key) 换成新尾,!==settled → 不删,保持链完整。
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return result;
}
