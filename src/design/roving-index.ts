// 焦点轮转(roving focus)的下标计算:tablist(design roving-tablist)与菜单(lib use-menu-keyboard)共用(此前两份逐字
// 相同的「Home / End + 方向键循环 + 当前项不在列表(-1)」规则与 indexOf)。纯函数,不碰 DOM 焦点。

export type RovingMove = 'first' | 'last' | 'next' | 'prev';

/** 当前下标 idx(不在列表为 -1)按 move 移动后的下标;count 须 > 0。next / prev 循环,-1 时 next → 首项、prev → 末项。 */
export function nextRovingIndex(move: RovingMove, idx: number, count: number): number {
  if (move === 'first') return 0;
  if (move === 'last') return count - 1;
  if (move === 'next') return idx < 0 ? 0 : (idx + 1) % count;
  return idx <= 0 ? count - 1 : idx - 1;
}

/** el 在 list 中的下标;不在 → -1。 */
export function indexOfElement(list: ArrayLike<Element>, el: Element | null): number {
  if (el === null) return -1;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === el) return i;
  }
  return -1;
}
