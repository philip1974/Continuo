// 等高行虚拟列表的 PageDown / PageUp 目标行(对齐 VSCode List focusNextPage / focusPreviousPage,搜索结果树与
// Quick Input 列表都走它):
// - PageDown:活动行在可视区末行(完全可见的最后一行)之上 → 先到末行;已在末行(或其下)→ 翻一页,末行成为首行
//  (VSCode 把末行滚到顶部后取新的末行)。
// - PageUp:活动行在可视区首行之下 → 先到首行;已在首行(或其上)→ 向上翻整页(VSCode scrollTop -= renderHeight 后取首行)。
// - 无活动行(-1)→ PageDown 到末行、PageUp 到首行。不循环,夹在 [0, count-1]。
// BDD: src/__tests__/picker-shared/(规则 6)、src/__tests__/workspace-search/(视图键盘)

export interface PageNavGeometry {
  /** 滚动容器 scrollTop。 */
  readonly scrollTop: number;
  /** 滚动容器可视高度(clientHeight)。 */
  readonly viewportHeight: number;
  /** 列表首行顶部在滚动内容里的偏移(容器 padding 等)。 */
  readonly listOffset: number;
  readonly rowHeight: number;
}

/** 返回目标行下标;count<=0 → -1。 */
export function pageNavTarget(dir: 1 | -1, current: number, count: number, g: PageNavGeometry): number {
  if (count <= 0) return -1;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  const h = g.rowHeight > 0 ? g.rowHeight : 1;
  const rows = Math.max(1, Math.floor(g.viewportHeight / h));
  const top = g.scrollTop - g.listOffset;
  // 完全可见的首 / 末行(容差 1px,防亚像素滚动值)
  const first = clamp(Math.ceil((top - 1) / h));
  const last = Math.max(first, clamp(Math.floor((top + g.viewportHeight + 1) / h) - 1));
  if (dir === 1) {
    if (current < 0 || current < last) return last;
    return clamp(current + Math.max(1, rows - 1));
  }
  if (current < 0 || current > first) return first;
  return clamp(current - rows);
}

/** 从 DOM 量几何:scrollEl = 滚动容器,listEl = 承载各行(首行 top=0)的元素。 */
export function measurePageNavGeometry(
  scrollEl: HTMLElement,
  listEl: HTMLElement | null,
  rowHeight: number,
): PageNavGeometry {
  const listOffset = listEl
    ? listEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
    : 0;
  return { scrollTop: scrollEl.scrollTop, viewportHeight: scrollEl.clientHeight, listOffset, rowHeight };
}
