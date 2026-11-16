// 关窗脏文件确认(dirty-close-confirm)复审:按 tab 记录「最近一次 autosave 失败」。
//
// 关窗计数默认排除脏 .md(关窗 flush 经 flushPendingAutoSave 落盘)。但 autosave 失败
// (ENOSPC/EACCES/EDITOR_DISK_CHANGED)后 tab 仍脏、scheduler 已无 pending timer,flush 不会重试
// → 排除它就会无确认丢失。useAutoSave 每次保存结束写入此表,countDirtyForClose 据此把失败态的
// 脏 .md 计入;DockShell 订阅版本号,失败态变化时重新上报计数。

const failedTabIds = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export function setAutoSaveFailed(tabId: string, failed: boolean): void {
  if (failedTabIds.has(tabId) === failed) return;
  if (failed) failedTabIds.add(tabId);
  else failedTabIds.delete(tabId);
  version += 1;
  for (const cb of listeners) cb();
}

export function isAutoSaveFailed(tabId: string): boolean {
  return failedTabIds.has(tabId);
}

/** useSyncExternalStore 用:失败态变化时通知。 */
export function subscribeAutoSaveFailures(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getAutoSaveFailureVersion(): number {
  return version;
}
