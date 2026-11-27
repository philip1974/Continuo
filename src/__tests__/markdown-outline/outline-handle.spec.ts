// @vitest-environment jsdom
// BDD: markdown-outline 第 3 / 4 条 —— Milkdown(编辑 / 预览)视图的大纲句柄:按标题序号读当前节 / 定位 / 快照恢复;句柄登记。见同目录 README。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetMarkdownOutlineForTest,
  createPmOutlineHandle,
  headingPositions,
  markdownOutlineHandleOf,
  onMarkdownOutlineHandlesChange,
  registerMarkdownOutline,
  type PmOutlineView,
} from '@/panels/Editor/markdown-outline-registry';

interface FakeNode {
  readonly type: { readonly name: string };
  readonly isTextblock: boolean;
  readonly pos: number;
  readonly children?: readonly FakeNode[];
}

const block = (name: string, pos: number, children?: FakeNode[]): FakeNode => ({
  type: { name },
  isTextblock: name === 'heading' || name === 'paragraph',
  pos,
  ...(children ? { children } : {}),
});

// 文档:h(0) p(10) blockquote(20)[h(21)] p(40) h(50)
const NODES = [block('heading', 0), block('paragraph', 10), block('blockquote', 20, [block('heading', 21)]), block('paragraph', 40), block('heading', 50)];

function fakeDoc(nodes: readonly FakeNode[]) {
  const walk = (list: readonly FakeNode[], f: (n: FakeNode, pos: number) => boolean | void): void => {
    for (const n of list) if (f(n, n.pos) !== false && n.children) walk(n.children, f);
  };
  return {
    type: { name: 'doc' },
    isTextblock: false,
    descendants: (f: (n: FakeNode, pos: number) => boolean | void) => walk(nodes, f),
    resolve: (pos: number) => ({ pos }),
  };
}

function setup(opts: { readonly head?: number; readonly tops?: Record<number, number> } = {}) {
  const scroller = document.createElement('div');
  scroller.getBoundingClientRect = () => ({ top: 100, bottom: 300, height: 200, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) });
  const dom = document.createElement('div');
  scroller.appendChild(dom);
  document.body.appendChild(scroller);
  const els = new Map<number, HTMLElement>();
  for (const [pos, top] of Object.entries(opts.tops ?? { 0: 110, 21: 250, 50: 600 })) {
    const el = document.createElement('h2');
    el.getBoundingClientRect = () => ({ top, bottom: top + 20, height: 20, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) });
    els.set(Number(pos), el);
  }
  const Selection = { near: (r: { pos: number }) => ({ head: r.pos, constructor: Selection }) };
  const state = { doc: fakeDoc(NODES), selection: { head: opts.head ?? 0, constructor: Selection } as { head: number; constructor: typeof Selection } };
  const view = {
    get state() {
      return {
        doc: state.doc,
        selection: state.selection,
        get tr() {
          const tr = {
            sel: null as unknown,
            meta: {} as Record<string, unknown>,
            setSelection(s: unknown) {
              tr.sel = s;
              return tr;
            },
            setMeta(k: string, v: unknown) {
              tr.meta[k] = v;
              return tr;
            },
          };
          return tr;
        },
      };
    },
    editable: true,
    dom,
    dispatch: vi.fn((tr: { sel: typeof state.selection; meta: Record<string, unknown> }) => {
      state.selection = tr.sel;
    }),
    focus: vi.fn(),
    nodeDOM: (pos: number) => els.get(pos) ?? null,
  };
  return { view, scroller, state, asView: view as unknown as PmOutlineView };
}

afterEach(() => {
  document.body.innerHTML = '';
  __resetMarkdownOutlineForTest();
});

describe('Milkdown 视图的大纲句柄', () => {
  it('标题位置:全文所有标题(含引用里的),文档顺序', () => {
    expect(headingPositions(fakeDoc(NODES) as never)).toEqual([0, 21, 50]);
  });

  it('编辑:当前节 = 光标之前最后一个标题;在第一个标题之前 → -1', () => {
    const { asView, scroller, state } = setup({ head: 45 });
    const handle = createPmOutlineHandle(() => asView, () => scroller, false);
    expect(handle.currentHeading()).toBe(1);
    state.selection = { ...state.selection, head: 55 };
    expect(handle.currentHeading()).toBe(2);
    const before = setup({ head: 0, tops: {} });
    // 文首就是标题:光标在标题里 → 该节
    expect(createPmOutlineHandle(() => before.asView, () => before.scroller, false).currentHeading()).toBe(0);
  });

  it('预览:当前节 = 顶边已到视口顶部附近的最后一个标题', () => {
    const { asView, scroller } = setup({ tops: { 0: 50, 21: 120, 50: 400 } });
    expect(createPmOutlineHandle(() => asView, () => scroller, true).currentHeading()).toBe(1);
    const top = setup({ tops: { 0: 200, 21: 400, 50: 600 } });
    expect(createPmOutlineHandle(() => top.asView, () => top.scroller, true).currentHeading()).toBe(-1);
  });

  it('定位:编辑模式光标落到标题开头;在视口外 → 滚到中央;focus 决定是否聚焦;没有该标题 → false', () => {
    const { view, asView, scroller, state } = setup();
    const handle = createPmOutlineHandle(() => asView, () => scroller, false);
    scroller.scrollTop = 0;
    expect(handle.revealHeading(2, { focus: false })).toBe(true);
    expect(state.selection.head).toBe(51);
    expect(view.dispatch.mock.calls[0]![0].meta['addToHistory']).toBe(false);
    expect(scroller.scrollTop).toBe(600 - 200 + 10); // 标题中线对到视口中线
    expect(view.focus).not.toHaveBeenCalled();
    scroller.scrollTop = 0;
    expect(handle.revealHeading(0, { focus: true })).toBe(true); // 已在视口内:不滚
    expect(scroller.scrollTop).toBe(0);
    expect(view.focus).toHaveBeenCalledTimes(1);
    expect(handle.revealHeading(9, { focus: false })).toBe(false);
  });

  it('预览定位只滚动、不改选区', () => {
    const { view, asView, scroller } = setup();
    expect(createPmOutlineHandle(() => asView, () => scroller, true).revealHeading(2, { focus: false })).toBe(true);
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it('快照:恢复选区与滚动;期间文档变了只恢复滚动;视图已拆除 → 不动', () => {
    const { view, asView, scroller, state } = setup({ head: 12 });
    const handle = createPmOutlineHandle(() => asView, () => scroller, false);
    scroller.scrollTop = 30;
    const restore = handle.snapshot();
    handle.revealHeading(2, { focus: false });
    scroller.scrollTop = 500;
    restore();
    expect(state.selection.head).toBe(12);
    expect(scroller.scrollTop).toBe(30);

    const restore2 = handle.snapshot();
    handle.revealHeading(2, { focus: false });
    state.doc = fakeDoc(NODES); // 外部同步换了文档
    view.dispatch.mockClear();
    scroller.scrollTop = 500;
    restore2();
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(30);

    expect(createPmOutlineHandle(() => null, () => scroller, false).currentHeading()).toBeNull();
    expect(createPmOutlineHandle(() => null, () => scroller, false).revealHeading(0, { focus: true })).toBe(false);
  });
});

describe('句柄登记', () => {
  it('按「编辑器组 + tab」登记;后登记者取代先登记者;注销只注销自己;登记 / 注销都通知', () => {
    const listener = vi.fn();
    const off = onMarkdownOutlineHandlesChange(listener);
    const a = createPmOutlineHandle(() => null, () => null, false);
    const b = createPmOutlineHandle(() => null, () => null, false);
    const offA = registerMarkdownOutline('/w/a.md', 'editor', a);
    const offB = registerMarkdownOutline('/w/a.md', 'editor', b);
    expect(markdownOutlineHandleOf('/w/a.md', 'editor')).toBe(b);
    expect(markdownOutlineHandleOf('/w/a.md', 'editor-2')).toBeUndefined();
    offA();
    expect(markdownOutlineHandleOf('/w/a.md', 'editor')).toBe(b);
    offB();
    expect(markdownOutlineHandleOf('/w/a.md', 'editor')).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(3);
    off();
  });
});
