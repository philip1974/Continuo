// ⌘D(添加下一个匹配,editor.action.addSelectionToNextFindMatch)/ ⇧⌘L(选择所有匹配,editor.action.selectHighlights)的分片版本。
// CodeMirror 的 selectNextOccurrence / selectSelectionMatches 一次 SearchCursor 扫到结果为止:词在文档里不再出现时就是整篇
// (8.7 MB 日志实测约 0.5s 卡住)。这里与 ⌘F 计数同一套分片(find-match-scan / codemirror-find 的 SCAN_SLICE_MS):先在当前按键里扫
// 一个时间片 —— 小文档就此扫完,行为与 CodeMirror 原命令逐项相同(同一结果、同一事务);扫不完的分片排到后续宏任务,扫完时文档 /
// 选区都没变才套用结果(期间任何事务都作废它)。语义照抄 @codemirror/search(src/selection-match.ts 的 findNextOccurrence /
// selectNextOccurrence、src/search.ts 的 selectSelectionMatches)。BDD: src/__tests__/editor-text-commands/

import { EditorView, type Command } from '@codemirror/view';
import { EditorSelection, type EditorState, type SelectionRange } from '@codemirror/state';
import { SearchCursor, selectNextOccurrence } from '@codemirror/search';

/** 每个时间片(与 ⌘F 计数的 SCAN_SLICE_MS 一致)。 */
const SLICE_MS = 8;
/** 块大小(UTF-16 码元;同 find-match-scan 的 LITERAL_CHUNK)。 */
const CHUNK = 32 * 1024;
/** selectSelectionMatches 的上限(CodeMirror:超过 1000 个就不做)。 */
const SELECT_ALL_MAX = 1000;

export interface OccurrenceScanOptions {
  /** 测试用。 */
  readonly chunk?: number;
  readonly sliceMs?: number;
  readonly now?: () => number;
}

interface Match {
  readonly from: number;
  readonly to: number;
}

/**
 * [from, to] 内文本 text 的匹配,按位置升序、不重叠 —— 与 `new SearchCursor(doc, text, from, to)` 逐个 next() 的序列相同,但按块推进,
 * 可在块之间停下。
 */
class SlicedMatches {
  private pos: number;
  private lastTo: number;
  private readonly buffered: Match[] = [];

  constructor(
    private readonly state: EditorState,
    private readonly text: string,
    from: number,
    private readonly to: number,
    private readonly chunk: number,
  ) {
    this.pos = from;
    this.lastTo = from;
  }

  /** 下一个匹配;null = 没有了;undefined = 到 deadline 还没找到(下次接着找)。至少扫一块。 */
  next(deadline: number, now: () => number): Match | null | undefined {
    for (;;) {
      const m = this.buffered.shift();
      if (m) return m;
      if (this.pos >= this.to) return null;
      this.scanChunk();
      if (this.buffered.length === 0 && now() >= deadline) return undefined;
    }
  }

  // 一块 [start, end):cursor 范围向后多延伸,接住起点在块内、终点越过块尾的匹配;起点 >= end 的留给下一块。匹配可能比 text 长
  //(SearchCursor 按码点比较:text 以半个代理对结尾时匹配到整个字符),延伸取 text 长度的两倍。
  private scanChunk(): void {
    const start = Math.max(this.pos, this.lastTo);
    const end = Math.min(this.to, start + this.chunk);
    const last = end >= this.to;
    const cursorTo = last ? this.to : Math.min(this.to, end + this.text.length * 2);
    const cursor = new SearchCursor(this.state.doc, this.text, start, cursorTo);
    for (cursor.next(); !cursor.done; cursor.next()) {
      const { from, to } = cursor.value;
      if (!last && from >= end) break;
      this.buffered.push({ from, to });
      this.lastTo = to;
    }
    this.pos = last ? this.to : end;
  }
}

type Step<T> = (deadline: number, now: () => number) => T | undefined;

/** 进行中的分片命令(每个视图至多一个):新命令取消旧的。 */
const running = new WeakMap<EditorView, { readonly state: EditorState; readonly id: string; cancel: () => void }>();

/**
 * 分片执行 step:当前调用里先跑一个时间片,扫完直接 apply(同步,与原命令相同);否则排到后续宏任务,扫完时视图状态未变才 apply。
 * 同一状态下同一命令已在进行 → 不重复开(按住 ⌘D 连按,原命令也是在同一状态上算出同一个结果)。
 */
function runSliced<T>(
  view: EditorView,
  id: string,
  step: Step<T>,
  apply: (result: T) => boolean,
  opts: OccurrenceScanOptions,
): boolean {
  const now = opts.now ?? (() => performance.now());
  const sliceMs = opts.sliceMs ?? SLICE_MS;
  const prev = running.get(view);
  if (prev && prev.state === view.state && prev.id === id) return true;
  prev?.cancel();
  running.delete(view);
  const first = step(now() + sliceMs, now);
  if (first !== undefined) return apply(first);
  const state = view.state;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const entry = {
    state,
    id,
    cancel: () => clearTimeout(timer),
  };
  const tick = (): void => {
    if (running.get(view) !== entry) return;
    if (view.state !== state || !view.dom.isConnected) {
      running.delete(view);
      return;
    }
    const r = step(now() + sliceMs, now);
    if (r === undefined) {
      timer = setTimeout(tick, 0);
      return;
    }
    running.delete(view);
    apply(r);
  };
  running.set(view, entry);
  timer = setTimeout(tick, 0);
  return true;
}

/**
 * 最后一个选区之后的下一个匹配,到尾绕回开头(不越过最后一个选区的起点);绕回后跳过已选中的;选区恰是一个完整单词时只认整词匹配。
 * 同 @codemirror/search findNextOccurrence。
 */
function nextOccurrenceStep(state: EditorState, text: string, chunk: number): Step<Match | null> {
  const { main, ranges } = state.selection;
  const lastRange = ranges[ranges.length - 1]!;
  const word = state.wordAt(main.head);
  const fullWord = word !== null && word.from === main.from && word.to === main.to;
  let cycled = false;
  let matches = new SlicedMatches(state, text, lastRange.to, state.doc.length, chunk);
  return (deadline, now) => {
    for (;;) {
      const m = matches.next(deadline, now);
      if (m === undefined) return undefined;
      if (m === null) {
        if (cycled) return null;
        cycled = true;
        matches = new SlicedMatches(state, text, 0, Math.max(0, lastRange.from - 1), chunk);
        continue;
      }
      if (cycled && ranges.some((r) => r.from === m.from)) continue;
      if (fullWord) {
        const w = state.wordAt(m.from);
        if (!w || w.from !== m.from || w.to !== m.to) continue;
      }
      return m;
    }
  };
}

/** ⌘D:选区为空 → 选中光标处单词(不搜索);否则把下一个匹配加为选区并滚到那里。同 @codemirror/search selectNextOccurrence。 */
export function selectNextOccurrenceSliced(view: EditorView, opts: OccurrenceScanOptions = {}): boolean {
  const { state } = view;
  const { ranges } = state.selection;
  if (ranges.some((r) => r.from === r.to)) return selectNextOccurrence(view);
  const text = state.sliceDoc(ranges[0]!.from, ranges[0]!.to);
  if (ranges.some((r) => state.sliceDoc(r.from, r.to) !== text)) return false;
  return runSliced(
    view,
    'next',
    nextOccurrenceStep(state, text, opts.chunk ?? CHUNK),
    (m) => {
      if (!m) return false;
      view.dispatch(
        state.update({
          selection: state.selection.addRange(EditorSelection.range(m.from, m.to), false),
          effects: EditorView.scrollIntoView(m.to),
        }),
      );
      return true;
    },
    opts,
  );
}

/** 选中当前选区文本的全部出现处(超过 1000 个不做)。同 @codemirror/search selectSelectionMatches。 */
export function selectSelectionMatchesSliced(view: EditorView, opts: OccurrenceScanOptions = {}): boolean {
  const { state } = view;
  const sel = state.selection;
  if (sel.ranges.length > 1 || sel.main.empty) return false;
  const { from, to } = sel.main;
  const matches = new SlicedMatches(state, state.sliceDoc(from, to), 0, state.doc.length, opts.chunk ?? CHUNK);
  const found: SelectionRange[] = [];
  let main = 0;
  const step: Step<SelectionRange[] | null> = (deadline, now) => {
    for (;;) {
      const m = matches.next(deadline, now);
      if (m === undefined) return undefined;
      if (m === null) return found;
      if (found.length > SELECT_ALL_MAX) return null;
      if (m.from === from) main = found.length;
      found.push(EditorSelection.range(m.from, m.to));
    }
  };
  return runSliced(
    view,
    'all',
    step,
    (ranges) => {
      if (!ranges) return false;
      view.dispatch(state.update({ selection: EditorSelection.create(ranges, main), userEvent: 'select.search.matches' }));
      return true;
    },
    opts,
  );
}

export const addSelectionToNextFindMatch: Command = (view) => selectNextOccurrenceSliced(view);

/** 选择所有匹配:空选区先取光标处单词(VSCode 同;CodeMirror 的 selectSelectionMatches 要求已有选区)。 */
export const selectHighlights: Command = (view) => {
  const { selection } = view.state;
  if (selection.ranges.length === 1 && selection.main.empty) selectNextOccurrence(view);
  return selectSelectionMatchesSliced(view);
};
