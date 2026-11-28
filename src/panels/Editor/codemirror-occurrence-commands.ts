// ⌘D(添加下一个匹配,editor.action.addSelectionToNextFindMatch)/ ⇧⌘L(选择所有匹配,editor.action.selectHighlights)的分片版本。
// CodeMirror 的 selectNextOccurrence / selectSelectionMatches 一次 SearchCursor 扫到结果为止:词在文档里不再出现时就是整篇
// (8.7 MB 日志实测约 0.5s 卡住)。这里与 ⌘F 计数同一套分片(find-match-scan / codemirror-find 的 SCAN_SLICE_MS):先在当前按键里扫
// 一个时间片 —— 小文档就此扫完,行为与 CodeMirror 原命令逐项相同(同一结果);扫不完的分片排到后续宏任务。扫描期间只看文档变化:
// 改动在已扫过的部分之后(日志追加)→ 接着扫,否则按命令重扫 / 作废;选区 / effect 事务不作废(大文档后台解析、外部追加时光标跟随
// 都会派发)。语义照抄 @codemirror/search(src/selection-match.ts 的 findNextOccurrence /
// selectNextOccurrence、src/search.ts 的 selectSelectionMatches)。BDD: src/__tests__/editor-text-commands/

import { EditorView, type Command, type ViewUpdate } from '@codemirror/view';
import {
  EditorSelection,
  StateEffect,
  type ChangeSet,
  type EditorState,
  type Extension,
  type SelectionRange,
  type Text,
} from '@codemirror/state';
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

/** changes 里最靠前的改动起点(旧文档坐标);没有改动 → Infinity。 */
function firstChangedPos(changes: ChangeSet): number {
  let min = Number.POSITIVE_INFINITY;
  changes.iterChangedRanges((fromA) => {
    if (fromA < min) min = fromA;
  });
  return min;
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
    private state: EditorState,
    private readonly text: string,
    from: number,
    private to: number,
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

  /**
   * 文档变了(changes:旧 → 新):改动全在已判定的位置之后(典型:日志在末尾持续追加)→ 已得结果原样有效(其前文本没变),范围
   * 到文档末尾的跟着延伸,从 `已判定位置 − 2·text 长度` 接着扫(接住跨改动边界的新匹配);改动落在已扫过的部分 → false(要重扫)。
   */
  remap(changes: ChangeSet, state: EditorState): boolean {
    const min = firstChangedPos(changes);
    if (min < Math.max(this.pos, this.lastTo)) return false;
    if (min <= this.to) {
      this.to = this.to === this.state.doc.length ? state.doc.length : changes.mapPos(this.to, 1);
      this.pos = Math.max(this.lastTo, this.pos - this.text.length * 2);
    }
    this.state = state;
    return true;
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

/** 一次分片命令的搜索:step 跑到 deadline(undefined = 没扫完);remap 在文档变化时把进度迁到新文档(false = 作废)。 */
interface Scan<T> {
  step(deadline: number, now: () => number): T | undefined;
  remap(changes: ChangeSet, state: EditorState): boolean;
}

interface RunningScan {
  readonly id: string;
  readonly scan: Scan<unknown>;
  /** 扫描跟到的文档(每次文档变化 remap 后更新)。 */
  doc: Text;
  /** 发起时的选区,随文档变化映射。 */
  selection: EditorSelection;
  cancel: () => void;
}

/** 进行中的分片命令(每个视图至多一个):新命令取消旧的。 */
const running = new WeakMap<EditorView, RunningScan>();

/**
 * 扫描期间的文档变化 → remap(选区 / effect 变化不影响扫描:大文档后台解析、外部追加时光标跟随末尾都会派发这类事务)。
 * 分片命令第一次转入后台时按需 appendConfig 挂到视图上(同 foldEnclosing 按需挂 codeFolding)。
 */
const onScanUpdate = (u: ViewUpdate): void => {
  const entry = running.get(u.view);
  if (!entry || !u.docChanged) return;
  if (u.startState.doc !== entry.doc || !entry.scan.remap(u.changes, u.state)) {
    entry.cancel();
    running.delete(u.view);
    return;
  }
  entry.doc = u.state.doc;
  entry.selection = entry.selection.map(u.changes);
};
const scanTracker: Extension = EditorView.updateListener.of(onScanUpdate);

/**
 * 分片执行 scan:当前调用里先跑一个时间片,扫完直接 apply(同步,与原命令相同);否则排到后续宏任务接着扫。只有文档变化会影响
 * 进行中的扫描(remap 迁移或作废);扫完时 apply 拿当前视图状态与映射后的发起选区。同一命令、同一文档与选区下已在进行 → 不重复开
 *(按住 ⌘D 连按,原命令也是在同一状态上算出同一个结果)。
 */
function runSliced<T>(
  view: EditorView,
  id: string,
  scan: Scan<T>,
  apply: (result: T, selection: EditorSelection) => boolean,
  opts: OccurrenceScanOptions,
): boolean {
  const now = opts.now ?? (() => performance.now());
  const sliceMs = opts.sliceMs ?? SLICE_MS;
  const prev = running.get(view);
  if (prev && prev.id === id && prev.doc === view.state.doc && prev.selection.eq(view.state.selection)) return true;
  prev?.cancel();
  running.delete(view);
  const selection = view.state.selection;
  const first = scan.step(now() + sliceMs, now);
  if (first !== undefined) return apply(first, selection);
  if (!view.state.facet(EditorView.updateListener).includes(onScanUpdate)) {
    view.dispatch({ effects: StateEffect.appendConfig.of(scanTracker) });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const entry: RunningScan = {
    id,
    scan,
    doc: view.state.doc,
    selection,
    cancel: () => clearTimeout(timer),
  };
  const tick = (): void => {
    if (running.get(view) !== entry) return;
    if (view.state.doc !== entry.doc || !view.dom.isConnected) {
      running.delete(view);
      return;
    }
    const r = scan.step(now() + sliceMs, now);
    if (r === undefined) {
      timer = setTimeout(tick, 0);
      return;
    }
    running.delete(view);
    apply(r, entry.selection);
  };
  running.set(view, entry);
  timer = setTimeout(tick, 0);
  return true;
}

/**
 * 最后一个选区之后的下一个匹配,到尾绕回开头(不越过最后一个选区的起点);绕回后跳过已选中的;选区恰是一个完整单词时只认整词匹配。
 * 同 @codemirror/search findNextOccurrence。文档变化:改动全在最后一个选区之后 → 两段各自迁移(到尾那段延伸到新末尾,绕回后
 * 仍先扫它新增的部分 —— 新内容里的匹配排在绕回之前);改动在选区或其之前 → 作废(选区是这条命令的输入)。
 */
function nextOccurrenceScan(state0: EditorState, text: string, chunk: number): Scan<Match | null> {
  let state = state0;
  const { main, ranges } = state.selection;
  const lastRange = ranges[ranges.length - 1]!;
  const word = state.wordAt(main.head);
  const fullWord = word !== null && word.from === main.from && word.to === main.to;
  const forward = new SlicedMatches(state, text, lastRange.to, state.doc.length, chunk);
  let wrapped: SlicedMatches | null = null;
  const accept = (m: Match, cycled: boolean): boolean => {
    if (cycled && ranges.some((r) => r.from === m.from)) return false;
    if (fullWord) {
      const w = state.wordAt(m.from);
      if (!w || w.from !== m.from || w.to !== m.to) return false;
    }
    return true;
  };
  return {
    step(deadline, now) {
      for (;;) {
        const f = forward.next(deadline, now);
        if (f === undefined) return undefined;
        if (f !== null) {
          if (accept(f, false)) return f;
          continue;
        }
        wrapped ??= new SlicedMatches(state, text, 0, Math.max(0, lastRange.from - 1), chunk);
        const m = wrapped.next(deadline, now);
        if (m === undefined) return undefined;
        if (m === null) return null;
        if (accept(m, true)) return m;
      }
    },
    remap(changes, next) {
      // 改动紧贴选区末尾也作废:wordAt / 整词判断看得到选区后一个字符
      if (firstChangedPos(changes) <= lastRange.to) return false;
      if (!forward.remap(changes, next) || (wrapped !== null && !wrapped.remap(changes, next))) return false;
      state = next;
      return true;
    },
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
    nextOccurrenceScan(state, text, opts.chunk ?? CHUNK),
    (m, selection) => {
      if (!m) return false;
      // 扫描期间用户改了选区 → 不再往(已不存在的)旧选区上加
      if (!view.state.selection.eq(selection)) return false;
      view.dispatch(
        view.state.update({
          selection: selection.addRange(EditorSelection.range(m.from, m.to), false),
          effects: EditorView.scrollIntoView(m.to),
        }),
      );
      return true;
    },
    opts,
  );
}

/**
 * 选中 [from, to) 文本的全部出现处(超过 1000 个不做;word = 空选区时取的光标处单词,此时不做也要选中该词,同原命令先选词)。
 * 文档变化:改动全在已扫过的部分之后 → 接着扫;否则对新文档从头重扫(同一文本)。选区变化不作废(结果整体替换选区)。
 */
function selectAllMatches(view: EditorView, from: number, to: number, word: boolean, opts: OccurrenceScanOptions): boolean {
  const chunk = opts.chunk ?? CHUNK;
  const text = view.state.sliceDoc(from, to);
  let target = { from, to };
  let matches = new SlicedMatches(view.state, text, 0, view.state.doc.length, chunk);
  let found: SelectionRange[] = [];
  let main = 0;
  const scan: Scan<SelectionRange[] | null> = {
    step(deadline, now) {
      for (;;) {
        const m = matches.next(deadline, now);
        if (m === undefined) return undefined;
        if (m === null) return found;
        if (found.length > SELECT_ALL_MAX) return null;
        if (m.from === target.from) main = found.length;
        found.push(EditorSelection.range(m.from, m.to));
      }
    },
    remap(changes, state) {
      target = { from: changes.mapPos(target.from, 1), to: changes.mapPos(target.to, -1) };
      if (!matches.remap(changes, state)) {
        matches = new SlicedMatches(state, text, 0, state.doc.length, chunk);
        found = [];
        main = 0;
      }
      return true;
    },
  };
  return runSliced(
    view,
    'all',
    scan,
    (ranges) => {
      if (!ranges) {
        if (word && target.to > target.from) view.dispatch({ selection: EditorSelection.single(target.from, target.to) });
        return false;
      }
      view.dispatch(view.state.update({ selection: EditorSelection.create(ranges, main), userEvent: 'select.search.matches' }));
      return true;
    },
    opts,
  );
}

/** 选中当前选区文本的全部出现处(超过 1000 个不做)。同 @codemirror/search selectSelectionMatches。 */
export function selectSelectionMatchesSliced(view: EditorView, opts: OccurrenceScanOptions = {}): boolean {
  const sel = view.state.selection;
  if (sel.ranges.length > 1 || sel.main.empty) return false;
  return selectAllMatches(view, sel.main.from, sel.main.to, false, opts);
}

/**
 * 选择所有匹配:空选区取光标处单词(VSCode 同;CodeMirror 的 selectSelectionMatches 要求已有选区)。结果同「selectNextOccurrence
 * 选词 + selectSelectionMatches」,但不先派发选词事务:直接用单词范围开始扫描(大文档里扫描转入后台时,选区已是这个词)。
 */
export function selectHighlightsSliced(view: EditorView, opts: OccurrenceScanOptions = {}): boolean {
  const { selection } = view.state;
  if (selection.ranges.length === 1 && selection.main.empty) {
    const word = view.state.wordAt(selection.main.head);
    if (!word) return false;
    return selectAllMatches(view, word.from, word.to, true, opts);
  }
  return selectSelectionMatchesSliced(view, opts);
}

export const addSelectionToNextFindMatch: Command = (view) => selectNextOccurrenceSliced(view);

export const selectHighlights: Command = (view) => selectHighlightsSliced(view);
