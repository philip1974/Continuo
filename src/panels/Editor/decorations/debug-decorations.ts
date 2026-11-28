import {
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter } from '@codemirror/view';
import { tWithFallback } from '@/i18n';
import { provideDebugDecorationsApplier } from './debug-decoration-sync';

export type DebugDecorationsState = {
  breakpointLines: readonly number[];
  execLine: number | null;
};

const setBreakpointLinesEffect = StateEffect.define<readonly number[]>();
const setExecLineEffect = StateEffect.define<number | null>();

type DebugGutterKind = 'breakpoint' | 'exec' | 'exec-on-breakpoint';

const MARKER_CLASS: Readonly<Record<DebugGutterKind, string>> = {
  breakpoint: 'cm-debug-breakpoint-marker',
  exec: 'cm-debug-exec-marker',
  'exec-on-breakpoint': 'cm-debug-exec-marker cm-debug-exec-on-breakpoint',
};

const MARKER_LABEL: Readonly<Record<DebugGutterKind, readonly [string, string]>> = {
  breakpoint: ['editor.debug_gutter.breakpoint', 'Breakpoint'],
  exec: ['editor.debug_gutter.exec', 'Current execution line'],
  'exec-on-breakpoint': ['editor.debug_gutter.exec_on_breakpoint', 'Breakpoint, current execution line'],
};

/**
 * 断点 gutter 的标记:断点红点;当前执行行箭头(VSCode glyph margin 的 debug-stackframe 图标,黄色
 * debugIcon.breakpointCurrentStackframeForeground);同一行两者都有 → 组合标记:箭头里嵌红点(VSCode 断点 + 栈帧同一 glyph 时
 * 的 codicon-debug-breakpoint.codicon-debug-stackframe 组合:箭头 + 内嵌圆点),红点不被箭头盖住。读屏标签(title / aria-label)
 * 说明是哪一种。
 */
class DebugGutterMarker extends GutterMarker {
  constructor(readonly kind: DebugGutterKind) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof DebugGutterMarker && other.kind === this.kind;
  }

  toDOM(): Node {
    const marker = document.createElement('span');
    marker.className = MARKER_CLASS[this.kind];
    const [key, fallback] = MARKER_LABEL[this.kind];
    const label = tWithFallback(key, fallback);
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', label);
    marker.title = label;
    return marker;
  }
}

const breakpointMarker = new DebugGutterMarker('breakpoint');
const execMarker = new DebugGutterMarker('exec');
const execOnBreakpointMarker = new DebugGutterMarker('exec-on-breakpoint');

function validLine(state: EditorView['state'], line: number | null): line is number {
  return line !== null && Number.isInteger(line) && line >= 1 && line <= state.doc.lines;
}

/** 断点行 + 执行行 → gutter 标记(同一行两者都有时只放组合标记)。 */
function createGutterMarkers(
  state: EditorView['state'],
  breakpointLines: readonly number[],
  execLine: number | null,
): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const exec = validLine(state, execLine) ? execLine : null;
  const lines = new Set(breakpointLines.filter((line) => validLine(state, line)));
  const all = Array.from(exec === null ? lines : new Set([...lines, exec])).sort((a, b) => a - b);
  for (const lineNumber of all) {
    const from = state.doc.line(lineNumber).from;
    const marker =
      lineNumber !== exec ? breakpointMarker : lines.has(lineNumber) ? execOnBreakpointMarker : execMarker;
    builder.add(from, from, marker);
  }
  return builder.finish();
}

function createExecLineDecorations(state: EditorView['state'], lineNumber: number | null): DecorationSet {
  if (!validLine(state, lineNumber)) return Decoration.none;
  const from = state.doc.line(lineNumber).from;
  return Decoration.set([Decoration.line({ class: 'cm-debug-exec-line' }).range(from)]);
}

// 两个 field 都把「行号」(store 里的事实来源)和据此算出的装饰一起存。文档一变就按行号重建,而不是让
// CodeMirror 把旧装饰随文本映射:外部改盘 reload 是整篇替换,映射后装饰全空;在断点上方增删行时,映射会让
// 红点跟着文本漂移、与 store 的行号脱节。重建发生在同一个事务里,不依赖之后是否还有 store 通知。
const breakpointLinesField = StateField.define<readonly number[]>({
  create: () => [],
  update(value, transaction) {
    let lines = value;
    for (const effect of transaction.effects) {
      if (effect.is(setBreakpointLinesEffect)) lines = effect.value;
    }
    return lines;
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
    return { line, decorations: createExecLineDecorations(transaction.state, line) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

// gutter 标记由上面两个 field 的行号算出(同一行断点 + 执行行合成一个标记);任一行号变化或文档变化时重建。
const debugGutterMarkersField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, transaction) {
    const lines = transaction.state.field(breakpointLinesField);
    const exec = transaction.state.field(execLineDecorationField).line;
    if (
      !transaction.docChanged &&
      lines === transaction.startState.field(breakpointLinesField) &&
      exec === transaction.startState.field(execLineDecorationField).line
    ) {
      return value;
    }
    return createGutterMarkers(transaction.state, lines, exec);
  },
});

const debugDecorationsHostExtension: Extension = [
  breakpointLinesField,
  execLineDecorationField,
  debugGutterMarkersField,
  gutter({
    class: 'cm-breakpoint-gutter',
    markers: (view) => view.state.field(debugGutterMarkersField),
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
    // 组合标记:箭头主体里嵌断点红点(在箭头的裁剪范围内,红点仍可见)。红点外描一圈画布色:红 / 黄两色亮度接近
    //(亮色 #d32f2f / #a87700 仅 1.26:1,红色盲下更难分),靠这圈底色把红点从箭头里分出来。
    '.cm-debug-exec-marker.cm-debug-exec-on-breakpoint::after': {
      content: '""',
      position: 'absolute',
      left: '1px',
      top: '50%',
      width: '5px',
      height: '5px',
      borderRadius: '50%',
      transform: 'translateY(-50%)',
      backgroundColor: 'var(--color-debug-breakpoint)',
      boxShadow: '0 0 0 1px var(--md-surface)',
    },
    // 强制颜色(Windows 高对比度):背景色被抹成 Canvas,只靠 background-color 画的红点 / 箭头 / 执行行黄底全部消失。
    // VSCode 的断点 / 执行箭头是 codicon 字形(前景色),高对比度下仍按系统前景色画出;这里用 forced-color-adjust: none
    // 保住背景并改系统色:红点 CanvasText、箭头 Highlight、箭头里的红点 HighlightText(与箭头必有对比);执行行画 1px
    // Highlight 轮廓(底色交给系统,文字照常 CanvasText)。
    '@media (forced-colors: active)': {
      '.cm-debug-breakpoint-marker': { forcedColorAdjust: 'none', backgroundColor: 'CanvasText' },
      '.cm-debug-exec-marker': { forcedColorAdjust: 'none', backgroundColor: 'Highlight' },
      '.cm-debug-exec-marker.cm-debug-exec-on-breakpoint::after': {
        forcedColorAdjust: 'none',
        backgroundColor: 'HighlightText',
        boxShadow: 'none',
      },
      '.cm-line.cm-debug-exec-line': { outline: '1px solid Highlight', outlineOffset: '-1px' },
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
