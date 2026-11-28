import {
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter } from '@codemirror/view';
import { provideDebugDecorationsApplier } from './debug-decoration-sync';

export type DebugDecorationsState = {
  breakpointLines: readonly number[];
  execLine: number | null;
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

/**
 * 当前执行行的 gutter 箭头(VSCode glyph margin 的 debug-stackframe 图标,黄色 debugIcon.breakpointCurrentStackframeForeground)。
 * 与断点红点同在断点 gutter;同一行两者都有时箭头叠在红点上(VSCode 同:断点 + 栈帧合成图标)。
 */
class ExecMarker extends GutterMarker {
  eq(other: GutterMarker): boolean {
    return other instanceof ExecMarker;
  }

  toDOM(): Node {
    const marker = document.createElement('span');
    marker.className = 'cm-debug-exec-marker';
    return marker;
  }
}

const execMarker = new ExecMarker();

function validLine(state: EditorView['state'], line: number | null): line is number {
  return line !== null && Number.isInteger(line) && line >= 1 && line <= state.doc.lines;
}

function createBreakpointMarkers(
  state: EditorView['state'],
  lines: readonly number[],
): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const uniqueLines = Array.from(new Set(lines))
    .filter((line) => validLine(state, line))
    .sort((a, b) => a - b);

  for (const lineNumber of uniqueLines) {
    const line = state.doc.line(lineNumber);
    builder.add(line.from, line.from, breakpointMarker);
  }

  return builder.finish();
}

function createExecLineDecorations(
  state: EditorView['state'],
  lineNumber: number | null,
): { readonly decorations: DecorationSet; readonly markers: RangeSet<GutterMarker> } {
  if (!validLine(state, lineNumber)) return { decorations: Decoration.none, markers: RangeSet.empty };
  const from = state.doc.line(lineNumber).from;
  return {
    decorations: Decoration.set([Decoration.line({ class: 'cm-debug-exec-line' }).range(from)]),
    markers: RangeSet.of([execMarker.range(from)]),
  };
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
  readonly markers: RangeSet<GutterMarker>;
}>({
  create: () => ({ line: null, decorations: Decoration.none, markers: RangeSet.empty }),
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
    return { line, ...createExecLineDecorations(transaction.state, line) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const debugDecorationsHostExtension: Extension = [
  breakpointMarkersField,
  execLineDecorationField,
  gutter({
    class: 'cm-breakpoint-gutter',
    markers: (view) => [
      view.state.field(breakpointMarkersField).markers,
      view.state.field(execLineDecorationField).markers,
    ],
  }),
  EditorView.baseTheme({
    '.cm-breakpoint-gutter': {
      minWidth: '16px',
    },
    '.cm-breakpoint-gutter .cm-gutterElement': {
      minWidth: '16px',
      padding: '0 4px',
      position: 'relative',
    },
    '.cm-debug-breakpoint-marker': {
      display: 'inline-block',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      backgroundColor: 'var(--color-debug-breakpoint)',
      verticalAlign: 'middle',
    },
    // 执行行黄底(VSCode editor.stackFrameHighlightBackground)。选择器带 .cm-line 抬高优先级:光标在执行行上时
    // 编辑器主题的 .cm-activeLine 背景不得盖住它(否则看起来只是普通当前行)。
    '.cm-line.cm-debug-exec-line': {
      backgroundColor: 'var(--color-debug-exec-line)',
    },
    // 右指箭头(VSCode codicon debug-stackframe),居中叠在断点 gutter 格子里。
    '.cm-debug-exec-marker': {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: '10px',
      height: '10px',
      transform: 'translate(-50%, -50%)',
      clipPath: 'polygon(0 15%, 55% 15%, 100% 50%, 55% 85%, 0 85%)',
      backgroundColor: 'var(--color-debug-exec-marker)',
      pointerEvents: 'none',
    },
  }),
];

export function debugDecorationsExtension(): Extension {
  return debugDecorationsHostExtension;
}

export function setDebugDecorations(view: EditorView, state: DebugDecorationsState): void {
  view.dispatch({
    effects: [
      setBreakpointLinesEffect.of(state.breakpointLines),
      setExecLineEffect.of(state.execLine),
    ],
  });
}

// perf E5:向随 EditorPanel 静态加载的同步模块注册实现(同步模块不得静态 import 本模块)。
provideDebugDecorationsApplier(setDebugDecorations);
