// 维护 windowId → windowSeq 映射,供 IPC handler 用 sender 反查 windowSeq。
// createMainWindow 时 set;window 'closed' 时 clear。

const map = new Map<number, number>();
const activeSeqs = new Set<number>();
const activeSeqRefs = new Map<number, number>();

function retainSeq(seq: number): void {
  activeSeqs.add(seq);
  activeSeqRefs.set(seq, (activeSeqRefs.get(seq) ?? 0) + 1);
}

function releaseSeq(seq: number): void {
  const next = (activeSeqRefs.get(seq) ?? 0) - 1;
  if (next > 0) {
    activeSeqRefs.set(seq, next);
    return;
  }
  activeSeqRefs.delete(seq);
  activeSeqs.delete(seq);
}

export function setWindowSeq(windowId: number, seq: number): void {
  const oldSeq = map.get(windowId);
  if (oldSeq === seq) return;
  if (oldSeq !== undefined) releaseSeq(oldSeq);
  map.set(windowId, seq);
  retainSeq(seq);
}

/** 返回 number 或 null,不要返回 undefined。 */
export function getWindowSeq(windowId: number): number | null {
  const seq = map.get(windowId);
  return seq === undefined ? null : seq;
}

export function clearWindow(windowId: number): void {
  const seq = map.get(windowId);
  if (seq === undefined) return;
  map.delete(windowId);
  releaseSeq(seq);
}

/** 返回当前活跃 windowSeq 集合(供 pruneLRUClosed 用). */
export function getActiveSeqs(): ReadonlySet<number> {
  return activeSeqs;
}

/** Test helper: reset state. */
export function _reset(): void {
  map.clear();
  activeSeqs.clear();
  activeSeqRefs.clear();
}
