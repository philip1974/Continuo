// 关窗脏文件确认(dirty-close-confirm)复审:按 tab 记录「最近一次 autosave 失败」。
//
// 关窗计数默认排除脏 .md(关窗 flush 经 flushPendingAutoSave 落盘)。但 autosave 失败
// (ENOSPC/EACCES/EDITOR_DISK_CHANGED)后 tab 仍脏、scheduler 已无 pending timer,flush 不会重试
// → 排除它就会无确认丢失。useAutoSave 每次保存结束写入此表,countDirtyForClose 据此把失败态的
// 脏 .md 计入;DockShell 订阅版本号,失败态变化时重新上报计数。

//
// 复审(f):记录按 tab id(= 文件路径)存,tab 从 editor store 消失(关闭 / 删除 / 重命名)即清除 —— 否则
// 重开同路径继承旧失败态、集合只增不减。旧 tab 的迟到 autosave 结果不得写入同 id 新实例:每个 tab 实例出现时
// 分配代际、消失时删除,保存开始时取本 tab 代际、结束时带回,不一致则丢弃(复审:此前用全局 epoch,关闭 /
// 重命名任意兄弟 tab 都会丢弃本 tab 的在途结果)。
// 复审:tab 变干净(显式保存 / 冲突覆盖等任何成功落盘)即清除其记录,且干净 tab 的迟到失败不记录 —— 否则
// 下次编辑就被当作「autosave 失败」误触发关窗确认。

import { useEditorStore, type EditorTab } from '@/stores/editor.store';

const failedTabIds = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
// 打开中的 tab id → 实例代际(全局单调递增分配,未打开 = 0)。
const tabGens = new Map<string, number>();
let nextGen = 1;

function notify(): void {
  version += 1;
  for (const cb of listeners) cb();
}

function isCleanTab(tabId: string): boolean {
  return useEditorStore.getState().tabs.some((t) => t.id === tabId && !t.dirty);
}

/**
 * 记录本 tab 最近一次 autosave 结果。epoch:保存开始时 getAutoSaveRecordEpoch(tabId) 的值;其间本 tab 消失
 * (可能关闭后重开)则丢弃这次结果。tab 已干净时不记失败。
 */
export function setAutoSaveFailed(tabId: string, failed: boolean, epoch?: number): void {
  if (epoch !== undefined && epoch !== (tabGens.get(tabId) ?? 0)) return;
  if (failedTabIds.has(tabId) === failed) return;
  if (failed && isCleanTab(tabId)) return;
  if (failed) failedTabIds.add(tabId);
  else failedTabIds.delete(tabId);
  notify();
}

export function getAutoSaveRecordEpoch(tabId: string): number {
  return tabGens.get(tabId) ?? 0;
}

function syncTabGens(tabs: readonly EditorTab[]): boolean {
  const ids = new Set(tabs.map((t) => t.id));
  for (const id of [...tabGens.keys()]) if (!ids.has(id)) tabGens.delete(id);
  for (const id of ids) if (!tabGens.has(id)) tabGens.set(id, nextGen++);
  let changed = false;
  for (const id of failedTabIds) {
    if (!ids.has(id)) {
      failedTabIds.delete(id);
      changed = true;
    }
  }
  return changed;
}

syncTabGens(useEditorStore.getState().tabs);
useEditorStore.subscribe((state, prev) => {
  if (state.tabs === prev.tabs) return;
  // 纯内容更新(按键):chromeVersion 不变且 tab 数不变 → 无增删改名、无 dirty 翻转,跳过(避免每次按键 O(n))。
  if (state.chromeVersion === prev.chromeVersion && state.tabs.length === prev.tabs.length) return;
  let changed = syncTabGens(state.tabs);
  for (const id of failedTabIds) {
    if (isCleanTab(id)) {
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
