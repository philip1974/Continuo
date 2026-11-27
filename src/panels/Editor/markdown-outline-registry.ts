// Markdown 编辑 / 预览(Milkdown)视图的「大纲句柄」:转到符号(⇧⌘O / Quick Open `@`)与侧栏大纲按标题序号定位、读出光标所在的节。
// 按标题序号(文档顺序第 k 个标题)而不是源码行对应:ProseMirror 文档与源码的标题一一对应、顺序相同(同一份 CommonMark 解析),
// 数标题节点只需遍历块结构,不必像按源码行定位那样序列化 + 重新解析全文(大文档每次光标移动都做会卡)。
// 同 markdown-reveal-registry:MilkdownEditor 视图就绪时按「编辑器组 + tab」登记,拆除时注销。
// 本模块在启动路径上(侧栏大纲、Quick Open),不得静态 import Milkdown:ProseMirror 视图按结构化类型使用。
// BDD: src/__tests__/markdown-outline/

export interface MarkdownOutlineRevealOptions {
  /** 聚焦编辑器(选择器预览 / 大纲单击不聚焦)。 */
  readonly focus: boolean;
}

export interface MarkdownOutlineHandle {
  /** 光标(编辑)/ 视口顶部(预览)所在的节:第几个标题;在第一个标题之前 → -1;未就绪 → null。 */
  currentHeading(): number | null;
  /** 定位到第 ordinal 个标题:不在视口内 → 滚到视口中央;编辑模式光标落到标题开头。没有该标题 / 未就绪 → false。 */
  revealHeading(ordinal: number, opts: MarkdownOutlineRevealOptions): boolean;
  /** 记下当前滚动位置与选区;返回恢复函数(选择器取消时回到原位置)。 */
  snapshot(): () => void;
}

const handles = new Map<string, MarkdownOutlineHandle>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** 句柄登记 / 注销时通知(大纲视图据此在视图挂载后重新读当前节)。返回取消订阅。 */
export function onMarkdownOutlineHandlesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function keyOf(tabId: string, groupId: string): string {
  return `${groupId}\u0000${tabId}`;
}

/** 视图就绪时登记(同组同 tab 后登记者取代先登记者);返回注销函数。 */
export function registerMarkdownOutline(tabId: string, groupId: string, handle: MarkdownOutlineHandle): () => void {
  const key = keyOf(tabId, groupId);
  handles.set(key, handle);
  emit();
  return () => {
    if (handles.get(key) !== handle) return;
    handles.delete(key);
    emit();
  };
}

/** 该 tab 在组 groupId 里的 Markdown 视图句柄(未挂载 → undefined)。 */
export function markdownOutlineHandleOf(tabId: string, groupId: string): MarkdownOutlineHandle | undefined {
  return handles.get(keyOf(tabId, groupId));
}

/** 测试用:清空。 */
export function __resetMarkdownOutlineForTest(): void {
  handles.clear();
  listeners.clear();
}

// ── ProseMirror 视图上的实现(结构化类型;@milkdown/kit 非直接依赖) ──

interface PmNodeLike {
  readonly type: { readonly name: string };
  readonly isTextblock: boolean;
  descendants(f: (node: PmNodeLike, pos: number) => boolean | void): void;
  resolve(pos: number): unknown;
}

interface PmSelectionLike {
  readonly head: number;
  readonly constructor: { near(pos: unknown): PmSelectionLike };
}

interface PmTransactionLike {
  setSelection(selection: PmSelectionLike): PmTransactionLike;
  setMeta(key: string, value: unknown): PmTransactionLike;
}

export interface PmOutlineView {
  readonly state: { readonly doc: PmNodeLike; readonly selection: PmSelectionLike; readonly tr: PmTransactionLike };
  readonly editable: boolean;
  readonly dom: HTMLElement;
  dispatch(tr: PmTransactionLike): void;
  focus(): void;
  nodeDOM(pos: number): Node | null;
}

/** 全文标题节点的位置(文档顺序;标题是文本块,不再下钻)。 */
export function headingPositions(doc: PmNodeLike): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      out.push(pos);
      return false;
    }
    return !node.isTextblock;
  });
  return out;
}

/** 有序位置表里 ≤ pos 的最后一个的下标;都大于 → -1。 */
function lastAtOrBefore(positions: readonly number[], pos: number): number {
  let lo = 0;
  let hi = positions.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid]! <= pos) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function elementAt(view: PmOutlineView, pos: number): HTMLElement | null {
  const node = view.nodeDOM(pos);
  return node !== null && node.nodeType === 1 ? (node as HTMLElement) : null;
}

/** 视口顶部所在的节(预览):顶边已到视口顶部(含 1/4 高度的余量)的最后一个标题。 */
function headingAtViewportTop(view: PmOutlineView, positions: readonly number[], scroller: HTMLElement): number {
  const box = scroller.getBoundingClientRect();
  const limit = box.top + Math.min(box.height / 4, 48);
  let found = -1;
  for (let i = 0; i < positions.length; i++) {
    const el = elementAt(view, positions[i]!);
    if (!el) continue;
    if (el.getBoundingClientRect().top <= limit) found = i;
    else break;
  }
  return found;
}

function revealInCenterIfOutside(el: HTMLElement, scroller: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (rect.top >= box.top && rect.bottom <= box.bottom) return;
  scroller.scrollTop += rect.top - (box.top + box.height / 2) + rect.height / 2;
}

/**
 * Milkdown 视图的大纲句柄。getView / getScroller 每次现取(视图拆除后返回 null);readonly = 预览(光标不显示,按视口顶部算当前节,
 * 定位只滚动不移光标)。
 */
export function createPmOutlineHandle(
  getView: () => PmOutlineView | null,
  getScroller: () => HTMLElement | null,
  readonly: boolean,
): MarkdownOutlineHandle {
  const live = (): { view: PmOutlineView; scroller: HTMLElement } | null => {
    try {
      const view = getView();
      const scroller = getScroller();
      if (!view?.state || !scroller || !view.dom.isConnected) return null;
      return { view, scroller };
    } catch {
      return null; // 已拆除
    }
  };
  return {
    currentHeading() {
      const v = live();
      if (!v) return null;
      const positions = headingPositions(v.view.state.doc);
      return readonly
        ? headingAtViewportTop(v.view, positions, v.scroller)
        : lastAtOrBefore(positions, v.view.state.selection.head);
    },
    revealHeading(ordinal, { focus }) {
      const v = live();
      if (!v) return false;
      const { view, scroller } = v;
      const pos = headingPositions(view.state.doc)[ordinal];
      if (pos === undefined) return false;
      if (!readonly) {
        const { selection } = view.state;
        const near = selection.constructor.near(view.state.doc.resolve(pos + 1));
        view.dispatch(view.state.tr.setSelection(near).setMeta('addToHistory', false));
      }
      const el = elementAt(view, pos);
      if (el) revealInCenterIfOutside(el, scroller);
      if (focus) view.focus();
      return true;
    },
    snapshot() {
      const v = live();
      if (!v) return () => {};
      const { view, scroller } = v;
      const top = scroller.scrollTop;
      const doc = view.state.doc;
      const selection = view.state.selection;
      return () => {
        if (!view.dom.isConnected) return;
        try {
          // 期间文档变了(外部同步)→ 原选区位置可能已无效,只恢复滚动
          if (!readonly && view.state.doc === doc) {
            view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false));
          }
        } catch {
          /* 已拆除 */
        }
        scroller.scrollTop = top;
      };
    },
  };
}
