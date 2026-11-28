// 编辑器光标样式 / 宽度 / 闪烁(VSCode editor.cursorStyle / editor.cursorWidth / editor.cursorBlinking),作用于 CodeMirror 自绘光标
//(drawSelection 的 .cm-cursorLayer):代码编辑器、Markdown 源码模式与冲突比较。
// Ported from microsoft/vscode (MIT, © Microsoft Corporation; see LICENSE-3RD-PARTY.md):
//   src/vs/editor/browser/viewParts/viewCursors/viewCursor.ts —— line 默认 2px(cursorWidth 0)、> 0 取该宽且不超过一个半角字符宽,
//     line-thin 1px;block / block-outline / underline / underline-thin 占一个字符宽,underline 2px、underline-thin 1px;
//   src/vs/editor/browser/viewParts/viewCursors/viewCursors.css —— smooth / phase / expand 的关键帧(0.5s alternate)。
// 刻意差异:block 光标用「差值混合」反色显示光标下的字(VSCode 把该字符以背景色重画在光标里;CodeMirror 光标层不含文字),
// 强制颜色(Windows 高对比度)下改画 CanvasText 实线框(背景会被系统色抹掉);闪烁以 1s 为一个完整周期循环(VSCode 0.5s alternate
// 等价;不随光标移动重新开始 —— VSCode 输入时重置闪烁);Markdown 编辑模式(原生光标)只同步形状与是否闪烁(nativeCaretStyle)。BDD: src/__tests__/editor-cursor-options/

import { drawSelection, EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { useMemo } from 'react';
import { useSettingValue } from '@/plugins/settings/values-store';
import {
  EDITOR_CURSOR_BLINKING,
  EDITOR_CURSOR_STYLE,
  EDITOR_CURSOR_WIDTH,
  type EditorCursorBlinking,
  type EditorCursorStyle,
} from '@/plugins/settings/core-setting-specs';

export interface EditorCursorOptions {
  readonly style: EditorCursorStyle;
  readonly width: number;
  readonly blinking: EditorCursorBlinking;
}

/** VSCode 线形光标的默认宽度(cursorWidth = 0 时;viewCursor `this._lineCursorWidth > 0 ? … : 2`)。 */
export const DEFAULT_LINE_CURSOR_WIDTH = 2;
/** 闪烁周期(VSCode 亮 / 灭各 500ms)。 */
const BLINK_CYCLE_MS = 1000;

/** 线形光标实际宽度(px):line = cursorWidth(0 → 2),line-thin = 1;其它样式 → null(占一个字符宽)。 */
export function lineCursorWidthPx(style: EditorCursorStyle, width: number): number | null {
  if (style === 'line-thin') return 1;
  if (style !== 'line') return null;
  return Number.isFinite(width) && width > 0 ? Math.round(width) : DEFAULT_LINE_CURSOR_WIDTH;
}

const CURSOR = '.cm-cursorLayer .cm-cursor';

export type ThemeSpec = Parameters<typeof EditorView.theme>[0];

function shapeRules(style: EditorCursorStyle, width: number): ThemeSpec {
  const line = lineCursorWidthPx(style, width);
  if (line !== null) {
    // 不超过一个字符宽(VSCode min(cursorWidth, typicalHalfwidthCharacterWidth)),居中压在两字符之间
    const w = `min(${line}px, 1ch)`;
    return { [CURSOR]: { borderLeftWidth: w, marginLeft: `calc(${w} / -2)` } };
  }
  const box = { borderLeft: 'none', marginLeft: '0', width: '1ch', boxSizing: 'border-box' };
  switch (style) {
    case 'block':
      return {
        // 差值混合:白色块把下面的字与底色反相(亮 / 暗 / 高对比度主题都可读;反相须纯白,不是主题色板颜色);混合须设在光标层上 ——
        // 层自带 z-index,是独立的层叠上下文,设在光标元素上只会与透明的层混合
        [CURSOR]: { ...box, backgroundColor: 'white' },
        '.cm-cursorLayer': { mixBlendMode: 'difference' },
        '@media (forced-colors: active)': {
          '.cm-cursorLayer': { mixBlendMode: 'normal' },
          [CURSOR]: { backgroundColor: 'transparent', border: '1px solid CanvasText' },
        },
      };
    case 'block-outline':
      return { [CURSOR]: { ...box, border: '1px solid var(--md-on-surface)' } };
    case 'underline':
    case 'underline-thin':
      return { [CURSOR]: { ...box, borderBottom: `${style === 'underline' ? 2 : 1}px solid var(--md-on-surface)` } };
    default:
      return {};
  }
}

// 完整一个周期(= VSCode 0.5s alternate 的一来一回)
const KEYFRAMES: Record<'smooth' | 'phase' | 'expand', Record<string, Record<string, string>>> = {
  smooth: { '0%, 10%, 90%, 100%': { opacity: '1' }, '30%, 70%': { opacity: '0' } },
  phase: { '0%, 10%, 90%, 100%': { opacity: '1' }, '45%, 55%': { opacity: '0' } },
  expand: { '0%, 10%, 90%, 100%': { transform: 'scaleY(1)' }, '40%, 60%': { transform: 'scaleY(0)' } },
};

function blinkRules(blinking: EditorCursorBlinking): ThemeSpec {
  if (blinking !== 'smooth' && blinking !== 'phase' && blinking !== 'expand') return {};
  const name = `wm-cursor-${blinking}`;
  const layer = '&.cm-focused > .cm-scroller > .cm-cursorLayer';
  // !important:CodeMirror 在光标层上写行内 animation-name / duration(自己的 cm-blink)
  const run = `${name} ${BLINK_CYCLE_MS}ms ease-in-out infinite !important`;
  return {
    [`@keyframes ${name}`]: KEYFRAMES[blinking],
    // expand 的上下收缩作用在每个光标上(作用在层上会把整层压扁),层本身不再闪烁
    ...(blinking === 'expand'
      ? { [layer]: { animation: 'none !important' }, [`${layer} .cm-cursor`]: { animation: run } }
      : { [layer]: { animation: run } }),
  };
}

/**
 * Markdown 编辑模式(ProseMirror,浏览器原生光标)能同步的部分:caret-shape(竖线 / 块 / 下划线)与 caret-animation(solid = 不闪烁)。
 * 宽度与 smooth / phase / expand 动画原生光标做不到,保持默认。
 */
export function nativeCaretStyle(o: EditorCursorOptions): Record<string, string> {
  const shape = o.style.startsWith('block') ? 'block' : o.style.startsWith('underline') ? 'underscore' : 'bar';
  return { caretShape: shape, ...(o.blinking === 'solid' ? { caretAnimation: 'manual' } : {}) };
}

/** 光标主题规则(EditorView.theme 的 spec;导出供规范检查)。 */
export function cursorThemeSpec(o: EditorCursorOptions): ThemeSpec {
  return { ...shapeRules(o.style, o.width), ...blinkRules(o.blinking) };
}

const cache = new Map<string, Extension>();

/** 光标扩展(放进 Compartment,设置变化时 reconfigure)。同一组选项复用同一个扩展实例。 */
export function editorCursor(o: EditorCursorOptions): Extension {
  const key = `${o.style}|${lineCursorWidthPx(o.style, o.width) ?? ''}|${o.blinking}`;
  let ext = cache.get(key);
  if (!ext) {
    ext = [
      // solid:不闪烁(CodeMirror cursorBlinkRate 0);其余由 blink 的周期或下面的自定义动画决定
      drawSelection({ cursorBlinkRate: o.blinking === 'solid' ? 0 : BLINK_CYCLE_MS }),
      EditorView.theme(cursorThemeSpec(o)),
    ];
    cache.set(key, ext);
  }
  return ext;
}

/** 当前设置的光标选项(引用在值不变时稳定)。 */
export function useEditorCursorOptions(): EditorCursorOptions {
  const style = useSettingValue(EDITOR_CURSOR_STYLE.id, EDITOR_CURSOR_STYLE.default);
  const width = useSettingValue(EDITOR_CURSOR_WIDTH.id, EDITOR_CURSOR_WIDTH.default);
  const blinking = useSettingValue(EDITOR_CURSOR_BLINKING.id, EDITOR_CURSOR_BLINKING.default);
  return useMemo(() => ({ style, width, blinking }), [style, width, blinking]);
}
