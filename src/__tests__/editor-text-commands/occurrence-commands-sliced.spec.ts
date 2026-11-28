// @vitest-environment jsdom
// ⌘D / ⇧⌘L 在大文档里不卡主线程:分片搜索(与 ⌘F 计数同一时间片);小文档(一个时间片内扫完)与 CodeMirror 原命令逐项相同。
// 扫不完的分片排到后续宏任务:扫描期间只看文档变化(末尾追加接着扫、改到扫过的部分重扫);选区 / effect 事务不作废 ⇧⌘L。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { selectNextOccurrence, selectSelectionMatches } from '@codemirror/search';
import {
  selectHighlightsSliced,
  selectNextOccurrenceSliced,
  selectSelectionMatchesSliced,
} from '../../panels/Editor/codemirror-occurrence-commands';

// jsdom 没有 Range 的布局接口(scrollIntoView 触发的测量会用到)
beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

const views: EditorView[] = [];
function viewOf(doc: string, selection: EditorSelection): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, selection, extensions: [EditorState.allowMultipleSelections.of(true)] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  vi.useRealTimers();
});

/** 确定性伪随机(可复现)。 */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function randomDoc(rand: () => number): string {
  const words = ['ab', 'abc', 'b', 'ab ab', 'x', '\n', ' ', 'bab', 'a\nb', 'é', '😀'];
  let out = '';
  const n = 5 + Math.floor(rand() * 60);
  for (let i = 0; i < n; i++) out += words[Math.floor(rand() * words.length)];
  return out;
}

function randomSelection(rand: () => number, len: number): EditorSelection {
  const n = 1 + Math.floor(rand() * 3);
  const ranges = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(rand() * (len + 1));
    const b = rand() < 0.3 ? a : Math.min(len, a + 1 + Math.floor(rand() * 4));
    ranges.push(EditorSelection.range(a, b));
  }
  return EditorSelection.create(ranges, Math.floor(rand() * ranges.length));
}

const snapshot = (v: EditorView) => JSON.stringify(v.state.selection.toJSON());
// 不让时间片用完:整条命令同步完成(小文档的情形);块很小,强制跨块边界。
const SYNC = { chunk: 5, sliceMs: Number.POSITIVE_INFINITY };

describe('小文档:与 CodeMirror 原命令逐项相同', () => {
  it('⌘D(selectNextOccurrence):随机文档 × 随机选区(含多选区、空光标、整词、绕回、跨块边界的匹配)', () => {
    const rand = rng(7);
    for (let i = 0; i < 400; i++) {
      const doc = randomDoc(rand);
      const sel = randomSelection(rand, doc.length);
      const a = viewOf(doc, sel);
      const b = viewOf(doc, sel);
      const ra = selectNextOccurrence(a);
      const rb = selectNextOccurrenceSliced(b, SYNC);
      expect(rb, `${JSON.stringify(doc)} ${JSON.stringify(sel.toJSON())}`).toBe(ra);
      expect(snapshot(b)).toBe(snapshot(a));
    }
  });

  it('⇧⌘L(selectSelectionMatches):随机文档 × 随机选区', () => {
    const rand = rng(11);
    for (let i = 0; i < 400; i++) {
      const doc = randomDoc(rand);
      const sel = randomSelection(rand, doc.length);
      const a = viewOf(doc, sel);
      const b = viewOf(doc, sel);
      expect(selectSelectionMatchesSliced(b, SYNC)).toBe(selectSelectionMatches(a));
      expect(snapshot(b)).toBe(snapshot(a));
    }
  });

  it('⇧⌘L / ⌘F2(selectHighlights):随机文档 × 随机选区(含单个空光标)= 原命令「选词 + selectSelectionMatches」', () => {
    const rand = rng(23);
    for (let i = 0; i < 400; i++) {
      const doc = randomDoc(rand);
      const sel = rand() < 0.5 ? EditorSelection.single(Math.floor(rand() * (doc.length + 1))) : randomSelection(rand, doc.length);
      const a = viewOf(doc, sel);
      const b = viewOf(doc, sel);
      const { selection } = a.state;
      if (selection.ranges.length === 1 && selection.main.empty) selectNextOccurrence(a);
      const ra = selectSelectionMatches(a);
      expect(selectHighlightsSliced(b, SYNC), `${JSON.stringify(doc)} ${JSON.stringify(sel.toJSON())}`).toBe(ra);
      expect(snapshot(b)).toBe(snapshot(a));
    }
  });

  it('⇧⌘L 空光标、超过 1000 个匹配 → 只选中该词(同原命令先选词)', () => {
    const doc = 'x '.repeat(1002);
    const a = viewOf(doc, EditorSelection.single(2));
    const b = viewOf(doc, EditorSelection.single(2));
    selectNextOccurrence(a);
    expect(selectHighlightsSliced(b, SYNC)).toBe(selectSelectionMatches(a));
    expect(snapshot(b)).toBe(snapshot(a));
  });

  it('超过 1000 个匹配 → 都不做(同原命令)', () => {
    const doc = 'x '.repeat(1002);
    const a = viewOf(doc, EditorSelection.single(0, 1));
    const b = viewOf(doc, EditorSelection.single(0, 1));
    expect(selectSelectionMatchesSliced(b, SYNC)).toBe(selectSelectionMatches(a));
    expect(snapshot(b)).toBe(snapshot(a));
  });
});

describe('大文档:分片、让出主线程', () => {
  // 每次读时钟前进 100ms:每个时间片只扫一块就让出
  let clock = 0;
  let reads = 0;
  const slow = {
    chunk: 1024,
    sliceMs: 8,
    now: () => {
      reads++;
      return (clock += 100);
    },
  };
  const doc = `${'lorem ipsum dolor '.repeat(2000)}needle${'lorem ipsum dolor '.repeat(2000)}`;
  const at = doc.indexOf('needle');
  // ⇧⌘L 空光标用:needle 两侧是空格,光标处单词就是 needle
  const wdoc = `${'lorem ipsum dolor '.repeat(2000)}needle ${'lorem ipsum dolor '.repeat(2000)}`;
  const wat = wdoc.indexOf('needle');

  beforeEach(() => {
    clock = 0;
    reads = 0;
    vi.useFakeTimers();
  });

  it('⌘D 对不再出现的词:按键当下不阻塞到扫完,分片在后续宏任务里扫完;没有匹配 → 选区不变', () => {
    const v = viewOf(doc, EditorSelection.single(at, at + 'needle'.length));
    const before = snapshot(v);
    expect(selectNextOccurrenceSliced(v, slow)).toBe(true);
    // 按键当下只扫了一个时间片(一块)
    const readsInKeystroke = reads;
    expect(readsInKeystroke).toBeLessThanOrEqual(2);
    vi.runAllTimers();
    // 其余的块在之后的宏任务里扫完(文档约 72K 码元 / 1024 一块)
    expect(reads).toBeGreaterThan(readsInKeystroke + 50);
    expect(snapshot(v)).toBe(before);
  });

  it('⌘D 找到后面的匹配:扫完后加选区(结果同原命令)', () => {
    const d = `${doc}needle`;
    const v = viewOf(d, EditorSelection.single(at, at + 6));
    const ref = viewOf(d, EditorSelection.single(at, at + 6));
    selectNextOccurrence(ref);
    selectNextOccurrenceSliced(v, slow);
    expect(v.state.selection.ranges).toHaveLength(1);
    vi.runAllTimers();
    expect(snapshot(v)).toBe(snapshot(ref));
  });

  it('⇧⌘L:分片扫完后选中全部出现处', () => {
    const v = viewOf(doc, EditorSelection.single(0, 5));
    const ref = viewOf(doc, EditorSelection.single(0, 5));
    selectSelectionMatches(ref);
    selectSelectionMatchesSliced(v, slow);
    expect(v.state.selection.ranges).toHaveLength(1);
    vi.runAllTimers();
    expect(snapshot(v)).toBe(snapshot(ref));
  });

  /** 每个宏任务之间跑一次 between,直到 v 的选区变成多个(结果已套用);上限内没套用就失败。 */
  function drain(v: EditorView, between: () => void): void {
    for (let i = 0; i < 2_000 && v.state.selection.ranges.length < 2; i++) {
      between();
      vi.advanceTimersToNextTimer();
    }
    expect(v.state.selection.ranges.length).toBeGreaterThan(1);
  }
  const fresh = (d: string, sel: EditorSelection, cmd: (v: EditorView) => unknown) => {
    const ref = viewOf(d, sel);
    cmd(ref);
    return snapshot(ref);
  };
  const highlightsRef = (v: EditorView) => {
    selectNextOccurrence(v);
    selectSelectionMatches(v);
  };

  it('⇧⌘L 光标在词内:不先派发选词事务,扫描转入后台时选区不变;扫完选中全部出现处', () => {
    const d = `${wdoc} needle`;
    const v = viewOf(d, EditorSelection.single(wat + 2));
    let transactions = 0;
    v.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of((u) => void (transactions += u.transactions.length))) });
    transactions = 0;
    expect(selectHighlightsSliced(v, slow)).toBe(true);
    expect(v.state.selection.ranges).toHaveLength(1);
    expect(v.state.selection.main.empty).toBe(true);
    // 转入后台只挂一次跟踪扩展(appendConfig),不改选区
    expect(transactions).toBeLessThanOrEqual(1);
    vi.runAllTimers();
    expect(v.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([
      [wat, wat + 6],
      [d.length - 6, d.length],
    ]);
    expect(v.state.selection.mainIndex).toBe(0);
  });

  it('⇧⌘L 扫描期间的选区变化 / 只带 effect 的事务(后台解析、光标跟随)不作废', () => {
    const d = `${wdoc} needle`;
    const v = viewOf(d, EditorSelection.single(wat + 2));
    const noop = StateEffect.define<null>();
    selectHighlightsSliced(v, slow);
    let n = 0;
    drain(v, () => {
      n++;
      v.dispatch(n % 2 ? { effects: noop.of(null) } : { selection: EditorSelection.cursor(n % d.length) });
    });
    expect(n).toBeGreaterThan(10);
    expect(snapshot(v)).toBe(fresh(d, EditorSelection.single(wat + 2), highlightsRef));
  });

  it('⇧⌘L 扫描期间日志在末尾持续追加:接着扫、不重来,最终结果含追加部分的匹配(= 对最终文档执行原命令)', () => {
    const v = viewOf(wdoc, EditorSelection.single(wat + 2));
    selectHighlightsSliced(v, slow);
    let n = 0;
    const ticksBefore = reads;
    drain(v, () => {
      n++;
      // 每个宏任务之间追加一行;每 5 行带一个 needle,有的被切成两半分两次追加(跨改动边界的匹配)
      const line = n % 5 === 0 ? 'x nee' : n % 5 === 1 && n > 1 ? 'dle y\n' : 'lorem\n';
      v.dispatch({ changes: { from: v.state.doc.length, insert: line } });
    });
    const final = v.state.doc.toString();
    expect(final.split('needle').length - 1).toBeGreaterThan(3);
    expect(snapshot(v)).toBe(fresh(final, EditorSelection.single(wat + 2), highlightsRef));
    // 没有因追加从头重扫(文档约 72K / 1024 一块:重扫的话读时钟次数会成倍)
    expect(reads - ticksBefore).toBeLessThan(200);
  });

  it('⇧⌘L 扫描期间改了已扫过的部分 → 对新文档重扫(结果 = 对最终文档执行原命令),不丢弃', () => {
    const v = viewOf(doc, EditorSelection.single(at, at + 6));
    selectSelectionMatchesSliced(v, slow);
    for (let i = 0; i < 5; i++) vi.advanceTimersToNextTimer();
    v.dispatch({ changes: { from: 3, insert: 'needle' } });
    vi.runAllTimers();
    const final = v.state.doc.toString();
    expect(v.state.selection.ranges).toHaveLength(2);
    expect(snapshot(v)).toBe(fresh(final, EditorSelection.single(at + 6, at + 12), selectSelectionMatches));
  });

  it('⌘D 扫描期间末尾追加:新内容里的匹配(排在绕回之前)照样找到;只带 effect 的事务不作废', () => {
    const v = viewOf(doc, EditorSelection.single(at, at + 6));
    const noop = StateEffect.define<null>();
    selectNextOccurrenceSliced(v, slow);
    let n = 0;
    drain(v, () => {
      n++;
      if (n === 30) v.dispatch({ changes: { from: v.state.doc.length, insert: ' needle' } });
      else v.dispatch({ effects: noop.of(null) });
    });
    const final = v.state.doc.toString();
    expect(snapshot(v)).toBe(fresh(final, EditorSelection.single(at, at + 6), selectNextOccurrence));
    expect(v.state.selection.ranges).toHaveLength(2);
  });

  it('⌘D 扫描期间在选区之前改了文档 → 作废', () => {
    const d = `${doc}needle`;
    const v = viewOf(d, EditorSelection.single(at, at + 6));
    selectNextOccurrenceSliced(v, slow);
    v.dispatch({ changes: { from: 0, insert: 'z' } });
    vi.runAllTimers();
    expect(v.state.selection.ranges.map((r) => [r.from, r.to])).toEqual([[at + 1, at + 7]]);
  });

  it('扫描期间文档 / 选区变了 → 结果作废,不套用', () => {
    const d = `${doc}needle`;
    const v = viewOf(d, EditorSelection.single(at, at + 6));
    selectNextOccurrenceSliced(v, slow);
    v.dispatch({ selection: EditorSelection.cursor(0) });
    vi.runAllTimers();
    expect(v.state.selection.ranges).toHaveLength(1);
    expect(v.state.selection.main.head).toBe(0);
  });
});
