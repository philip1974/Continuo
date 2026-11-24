// 维护 windowId → windowSeq 映射,供 IPC handler 用 sender 反查 windowSeq。
// createMainWindow 时 set;window 'closed' 时 clear。

import { createKeyedCounter } from '../lib/keyed-counter';

const map = new Map<number, number>();
/** seq → 引用它的窗口数;key 集合即活跃 seq(同一 seq 可被多个 windowId 引用,最后一个 clear 才移除)。 */
const activeSeqRefs = createKeyedCounter<number>();

export function setWindowSeq(windowId: number, seq: number): void {
  const oldSeq = map.get(windowId);
  if (oldSeq === seq) return;
  if (oldSeq !== undefined) activeSeqRefs.dec(oldSeq);
  map.set(windowId, seq);
  activeSeqRefs.inc(seq);
}

/** 当前登记的主窗口数(不含 popout:popout 不登记 windowSeq)。 */
export function windowSeqCount(): number {
  return map.size;
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
  activeSeqRefs.dec(seq);
}

/** 当前活跃 windowSeq(供 LRU 保护集用;直接迭代计数 key,不复制)。 */
export function getActiveSeqs(): Iterable<number> {
  return activeSeqRefs.keys();
}

/** Test helper: reset state. */
export function _reset(): void {
  map.clear();
  activeSeqRefs.clear();
}
