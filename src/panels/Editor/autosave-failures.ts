// 关窗脏文件确认(dirty-close-confirm)复审:按 tab 记录「最近一次 autosave 失败」。
//
// 关窗计数默认排除脏 .md(关窗 flush 经 flushPendingAutoSave 落盘)。但 autosave 失败
// (ENOSPC/EACCES/EDITOR_DISK_CHANGED)后 tab 仍脏、scheduler 已无 pending timer,flush 不会重试
// → 排除它就会无确认丢失。useAutoSave 每次保存结束写入此表,countDirtyForClose 据此把失败态的
// 脏 .md 计入;DockShell 订阅版本号,失败态变化时重新上报计数。

//
// 复审(f):记录按 tab id(= 文件路径)存,tab 从 editor store 消失(关闭 / 删除 / 重命名)即清除 —— 否则
// 重开同路径继承旧失败态、集合只增不减。旧 tab 的迟到 autosave 结果不得写入同 id 新实例:任一 tab 消失时
// 递增 epoch,保存开始时取 epoch、结束时带回,不一致则丢弃(偏保守:丢掉的失败结果由关窗 flush 后的
// 最终脏检查兜底,丢掉的成功结果只会让非脏 tab 留有记录,计数时先看 dirty 不受影响)。

import { useEditorStore } from '@/stores/editor.store';

const failedTabIds = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let recordEpoch = 0;

function notify(): void {
  version += 1;
  for (const cb of listeners) cb();
}

/**
 * 记录本 tab 最近一次 autosave 结果。epoch:保存开始时 getAutoSaveRecordEpoch() 的值;其间有 tab 消失
 * (可能是本 tab 关闭后重开)则丢弃这次结果。
 */
export function setAutoSaveFailed(tabId: string, failed: boolean, epoch?: number): void {
  if (epoch !== undefined && epoch !== recordEpoch) return;
  if (failedTabIds.has(tabId) === failed) return;
  if (failed) failedTabIds.add(tabId);
  else failedTabIds.delete(tabId);
  notify();
}

export function getAutoSaveRecordEpoch(): number {
  return recordEpoch;
}

let knownTabIds = new Set(useEditorStore.getState().tabs.map((t) => t.id));
useEditorStore.subscribe((state, prev) => {
  if (state.tabs === prev.tabs) return;
  // 纯内容更新(按键):chromeVersion 不变且 tab 数不变 → 无增删改名,跳过(避免每次按键 O(n) 建集合)。
  if (state.chromeVersion === prev.chromeVersion && state.tabs.length === prev.tabs.length) return;
  const ids = new Set(state.tabs.map((t) => t.id));
  let removed = false;
  for (const id of knownTabIds) {
    if (!ids.has(id)) {
      removed = true;
      break;
    }
  }
  knownTabIds = ids;
  if (!removed) return;
  recordEpoch += 1;
  let changed = false;
  for (const id of failedTabIds) {
    if (!ids.has(id)) {
      failedTabIds.delete(id);
      changed = true;
    }
  }
  if (changed) notify();
});

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
