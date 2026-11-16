// 关窗脏文件确认(dirty-close-confirm):活动 tab 的 autosave 能否由关窗 flush 落盘。
//
// 关窗计数只豁免「活动 tab(持有 autosave scheduler)」的脏 .md:其 scheduler 有 pending / 在途保存,
// 关窗 flush 经 flushPendingAutoSave 落盘。非活动 tab 切走时 useAutoSave 已 flush,仍脏即失败或在途,
// 关窗 flush 不会重试 → 一律计入(复审:此前按 tab 记失败记录,重命名非活动失败 tab 后记录被清 → 无确认丢失)。
// 活动 tab 的 autosave 失败(ENOSPC/EACCES/EDITOR_DISK_CHANGED)后无 pending timer,flush 不会重试 → 同样计入。
//
// 状态绑定 scheduler 实例(useAutoSave 按 tabId 建):切 tab / 重命名 / 关闭重开都会换实例,新实例从「未失败」
// 开始,且 tab 仍脏时立即重新 schedule(关窗 flush 会重试);旧实例的迟到结果因实例不匹配被丢弃。
// 再次 schedule(继续编辑 / 显式保存后再编辑)即清除失败态 —— 有 pending,flush 会落盘。
// DockShell 订阅版本号,状态变化时重新上报。

let owner: { readonly tabId: string; readonly token: object } | null = null;
let failed = false;
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const cb of listeners) cb();
}

/** useAutoSave:token(scheduler 实例)成为活动 tab 的 autosave 持有者。 */
export function claimAutoSave(tabId: string, token: object): void {
  owner = { tabId, token };
  failed = false;
  notify();
}

/** useAutoSave:token 不再持有(切走 / 卸载)。非当前持有者 → no-op。 */
export function releaseAutoSave(token: object): void {
  if (owner?.token !== token) return;
  owner = null;
  failed = false;
  notify();
}

/** 记录持有者最近一次 autosave 结果(或 schedule 后清除失败态)。非当前持有者(旧实例迟到结果)→ 丢弃。 */
export function setAutoSaveFailed(token: object, value: boolean): void {
  if (owner?.token !== token || failed === value) return;
  failed = value;
  notify();
}

/** 该 tab 的脏改动会被关窗 flush 落盘(活动 autosave 持有者且最近一次未失败)。 */
export function willAutoSaveOnClose(tabId: string): boolean {
  return owner !== null && owner.tabId === tabId && !failed;
}

/** useSyncExternalStore 用:状态变化时通知。 */
export function subscribeAutoSaveFailures(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getAutoSaveFailureVersion(): number {
  return version;
}
