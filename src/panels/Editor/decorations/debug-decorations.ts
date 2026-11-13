import {
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter } from '@codemirror/view';

export type DebugDecorationsState = {
  breakpointLines?: readonly number[];
  execLine?: number | null;
};

const setBreakpointLinesEffect = StateEffect.define<readonly number[]>();
const setExecLineEffect = StateEffect.define<number | null>();

class BreakpointMarker extends GutterMarker {
  eq(other: GutterMarker): boolean {
    return other instanceof BreakpointMarker;
  }

  toDOM(): Node {
    const marker = document.createElement('span');
    marker.className = 'cm-debug-breakpoint-marker';
    return marker;
  }
}

const breakpointMarker = new BreakpointMarker();

function createBreakpointMarkers(
  state: EditorView['state'],
  lines: readonly number[],
): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const uniqueLines = Array.from(new Set(lines))
    .filter((line) => Number.isInteger(line) && line >= 1 && line <= state.doc.lines)
    .sort((a, b) => a - b);

  for (const lineNumber of uniqueLines) {
    const line = state.doc.line(lineNumber);
    builder.add(line.from, line.from, breakpointMarker);
  }

  return builder.finish();
}

function createExecLineDecoration(
  state: EditorView['state'],
  lineNumber: number | null,
): DecorationSet {
  if (
    lineNumber === null ||
    !Number.isInteger(lineNumber) ||
    lineNumber < 1 ||
    lineNumber > state.doc.lines
  ) {
    return Decoration.none;
  }

  return Decoration.set([
    Decoration.line({ class: 'cm-debug-exec-line' }).range(state.doc.line(lineNumber).from),
  ]);
}

// 两个 field 都把「行号」(store 里的事实来源)和据此算出的装饰一起存。文档一变就按行号重建,而不是让
// CodeMirror 把旧装饰随文本映射:外部改盘 reload 是整篇替换,映射后装饰全空;在断点上方增删行时,映射会让
// 红点跟着文本漂移、与 store 的行号脱节。重建发生在同一个事务里,不依赖之后是否还有 store 通知。
const breakpointMarkersField = StateField.define<{
  readonly lines: readonly number[];
  readonly markers: RangeSet<GutterMarker>;
}>({
  create: () => ({ lines: [], markers: RangeSet.empty }),
  update(value, transaction) {
    let lines = value.lines;
    for (const effect of transaction.effects) {
      if (effect.is(setBreakpointLinesEffect)) lines = effect.value;
    }
    if (lines === value.lines && !transaction.docChanged) return value;
    return { lines, markers: createBreakpointMarkers(transaction.state, lines) };
  },
});

const execLineDecorationField = StateField.define<{
  readonly line: number | null;
  readonly decorations: DecorationSet;
}>({
  create: () => ({ line: null, decorations: Decoration.none }),
  update(value, transaction) {
    let line = value.line;
    let changed = false;
    for (const effect of transaction.effects) {
      if (effect.is(setExecLineEffect)) {
        line = effect.value;
        changed = true;
      }
    }
    if (!changed && !transaction.docChanged) return value;
    return { line, decorations: createExecLineDecoration(transaction.state, line) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const debugDecorationsHostExtension: Extension = [
  breakpointMarkersField,
  execLineDecorationField,
  gutter({
    class: 'cm-breakpoint-gutter',
    markers: (view) => view.state.field(breakpointMarkersField).markers,
  }),
  EditorView.baseTheme({
    '.cm-breakpoint-gutter': {
      minWidth: '16px',
    },
    '.cm-breakpoint-gutter .cm-gutterElement': {
      minWidth: '16px',
      padding: '0 4px',
    },
    '.cm-debug-breakpoint-marker': {
      display: 'inline-block',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: 'var(--color-debug-breakpoint)',
      verticalAlign: 'middle',
    },
    '.cm-debug-exec-line': {
      backgroundColor: 'var(--color-debug-exec-line)',
    },
  }),
];

export function debugDecorationsExtension(): Extension {
  return debugDecorationsHostExtension;
}

export function setDebugDecorations(view: EditorView, state: DebugDecorationsState): void {
  const effects: StateEffect<unknown>[] = [];
  if (state.breakpointLines !== undefined) {
    effects.push(setBreakpointLinesEffect.of(state.breakpointLines));
  }
  if (state.execLine !== undefined) {
    effects.push(setExecLineEffect.of(state.execLine));
  }
  if (effects.length > 0) {
    view.dispatch({ effects });
  }
}
