// @vitest-environment jsdom
// ⌘D / ⇧⌘L 在大文档里不卡主线程:分片搜索(与 ⌘F 计数同一时间片);小文档(一个时间片内扫完)与 CodeMirror 原命令逐项相同。
// 扫不完的分片排到后续宏任务,扫完时文档 / 选区没变才套用。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { selectNextOccurrence, selectSelectionMatches } from '@codemirror/search';
import {
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
