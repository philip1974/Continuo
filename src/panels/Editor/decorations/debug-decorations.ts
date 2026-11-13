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

const breakpointMarkersField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, transaction) {
    let next = markers.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setBreakpointLinesEffect)) {
        next = createBreakpointMarkers(transaction.state, effect.value);
      }
    }
    return next;
  },
});

const execLineDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setExecLineEffect)) {
        next = createExecLineDecoration(transaction.state, effect.value);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * 文档版本:每次文档变化 +1。装饰是按行号贴的,文档一变(尤其外部改盘 reload 的整篇替换,CodeMirror 会把
 * 已有装饰映射成空)原先贴的位置就不可信 —— 同步侧把它计入「已应用」签名,文档变过就按行号重贴。
 */
const debugDocVersionField = StateField.define<number>({
  create: () => 0,
  update: (version, transaction) => (transaction.docChanged ? version + 1 : version),
});

/** 该 view 的文档版本(未装 debug 装饰扩展的 view 恒为 0)。 */
export function debugDocVersion(view: EditorView): number {
  return view.state.field(debugDocVersionField, false) ?? 0;
}

const debugDecorationsHostExtension: Extension = [
  debugDocVersionField,
  breakpointMarkersField,
  execLineDecorationField,
  gutter({
    class: 'cm-breakpoint-gutter',
    markers: (view) => view.state.field(breakpointMarkersField),
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
