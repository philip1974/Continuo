// 维护 windowId → windowSeq 映射,供 IPC handler 用 sender 反查 windowSeq。
// createMainWindow 时 set;window 'closed' 时 clear。

const map = new Map<number, number>();

export function setWindowSeq(windowId: number, seq: number): void {
  map.set(windowId, seq);
}

/** 返回 number 或 null,不要返回 undefined。 */
export function getWindowSeq(windowId: number): number | null {
  const seq = map.get(windowId);
  return seq === undefined ? null : seq;
}

export function clearWindow(windowId: number): void {
  map.delete(windowId);
}

/** 返回当前活跃 windowSeq 集合(供 pruneLRUClosed 用). */
export function getActiveSeqs(): Set<number> {
  return new Set(map.values());
}

/** Test helper: reset state. */
export function _reset(): void {
  map.clear();
}
