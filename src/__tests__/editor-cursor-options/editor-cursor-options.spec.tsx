// @vitest-environment jsdom
// BDD: editor-cursor-options —— 光标样式 / 宽度 / 闪烁设置与 CodeMirror 光标扩展。见同目录 README。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, getDrawSelectionConfig } from '@codemirror/view';
import {
  EDITOR_CURSOR_BLINKING,
  EDITOR_CURSOR_STYLE,
  EDITOR_CURSOR_WIDTH,
} from '@/plugins/settings/core-setting-specs';
import {
  blockCursorGlyph,
  cursorThemeSpec,
  editorCursor,
  lineCursorWidthPx,
  nativeCaretStyle,
  type EditorCursorOptions,
} from '@/panels/Editor/codemirror-cursor';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const opts = (o: Partial<EditorCursorOptions> = {}): EditorCursorOptions => ({ style: 'line', width: 0, blinking: 'blink', ...o });
let views: EditorView[] = [];

function mount(o: EditorCursorOptions): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc: 'abc', extensions: [drawSelection(), editorCursor(o)] }) });
  views.push(view);
  return view;
}

/** 文档里所有已挂载的 CSS 规则文本(CodeMirror StyleModule 挂到 <style>)。 */
function cssText(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) for (const rule of Array.from(sheet.cssRules)) out.push(rule.cssText);
  return out.join('\n');
}

afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
  document.body.innerHTML = '';
});

describe('设置项(VSCode 同 id / 取值 / 默认值)', () => {
  it('editor.cursorStyle / cursorWidth / cursorBlinking', () => {
    expect(EDITOR_CURSOR_STYLE).toMatchObject({ id: 'editor.cursorStyle', category: 'editor', type: 'select', default: 'line' });
    expect(EDITOR_CURSOR_STYLE.enum!.map((e) => e.value)).toEqual(['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin']);
    expect(EDITOR_CURSOR_WIDTH).toMatchObject({ id: 'editor.cursorWidth', type: 'number', default: 0, min: 0 });
    expect(EDITOR_CURSOR_BLINKING).toMatchObject({ id: 'editor.cursorBlinking', default: 'blink' });
    expect(EDITOR_CURSOR_BLINKING.enum!.map((e) => e.value)).toEqual(['blink', 'smooth', 'phase', 'expand', 'solid']);
  });

  it('选项与说明三语齐全;编辑器 tab 注册', () => {
    for (const spec of [EDITOR_CURSOR_STYLE, EDITOR_CURSOR_WIDTH, EDITOR_CURSOR_BLINKING]) {
      for (const cat of [en, zh, ko] as Array<Record<string, string>>) {
        expect(cat[spec.titleKey!], spec.id).toEqual(expect.any(String));
        expect(cat[spec.descriptionKey!], spec.id).toEqual(expect.any(String));
        for (const e of spec.enum ?? []) expect(cat[e.labelKey!], e.labelKey).toEqual(expect.any(String));
      }
    }
    const plugin = src('src/core-plugins/EditorTabPlugin.ts');
    for (const name of ['EDITOR_CURSOR_STYLE', 'EDITOR_CURSOR_WIDTH', 'EDITOR_CURSOR_BLINKING']) {
      expect(plugin).toContain(`this.addSettingItem(${name})`);
    }
  });
});

describe('竖线宽度(VSCode viewCursor)', () => {
  it('cursorWidth 0 → 2px,n → npx;细竖线 1px;块类 / 下划线类占一个字符宽', () => {
    expect(lineCursorWidthPx('line', 0)).toBe(2);
    expect(lineCursorWidthPx('line', 3)).toBe(3);
    expect(lineCursorWidthPx('line', Number.NaN)).toBe(2);
    expect(lineCursorWidthPx('line-thin', 5)).toBe(1);
    for (const s of ['block', 'underline', 'block-outline', 'underline-thin'] as const) expect(lineCursorWidthPx(s, 3)).toBeNull();
  });
});

describe('CodeMirror 光标扩展', () => {
  const C = '.cm-cursorLayer .cm-cursor';

  it('默认:光标 2px(不超过一个字符宽、居中压在字符间),闪烁周期 1000ms;样式模块真实挂到编辑器所在文档', () => {
    const view = mount(opts());
    expect(getDrawSelectionConfig(view.state).cursorBlinkRate).toBe(1000);
    expect(cursorThemeSpec(opts())).toEqual({ [C]: { borderLeftWidth: 'min(2px, 1ch)', marginLeft: 'calc(min(2px, 1ch) / -2)' } });
    expect(cursorThemeSpec(opts({ width: 4 }))[C]).toMatchObject({ borderLeftWidth: 'min(4px, 1ch)' });
    expect(cssText()).toContain('margin-left: calc(min(2px,1ch) /-2)');
  });

  it('不闪烁(solid)→ cursorBlinkRate 0', () => {
    expect(getDrawSelectionConfig(mount(opts({ blinking: 'solid' })).state).cursorBlinkRate).toBe(0);
  });

  it('block:实心光标色块(--md-on-surface)、块内以编辑器背景色(--md-surface)重画光标下的字,不再用差值混合;CodeMirror 自己的光标透明;强制颜色下 CanvasText 块 + Canvas 字', () => {
    const spec = cursorThemeSpec(opts({ style: 'block' }));
    const B = '.cm-cursorLayer .cm-blockCursor';
    expect(spec[C]).toMatchObject({ borderLeft: 'none', width: '1ch', backgroundColor: 'transparent' });
    expect(spec[B]).toMatchObject({ minWidth: '1ch', backgroundColor: 'var(--md-on-surface)', color: 'var(--md-surface)', display: 'none' });
    expect(spec['&.cm-focused > .cm-scroller > .cm-cursorLayer .cm-blockCursor']).toEqual({ display: 'block' });
    expect(spec['@media (forced-colors: active)']).toEqual({
      [B]: { forcedColorAdjust: 'none', backgroundColor: 'CanvasText', color: 'Canvas' },
    });
    expect(JSON.stringify(spec)).not.toContain('mixBlendMode');
    mount(opts({ style: 'block' }));
    expect(cssText()).not.toContain('mix-blend-mode');
    // 只有 block 才挂自己的光标层(编辑器里多一个 cm-cursorLayer)
    const layers = (o: EditorCursorOptions) => mount(o).dom.querySelectorAll('.cm-cursorLayer').length;
    expect(layers(opts({ style: 'block' }))).toBe(layers(opts()) + 1);
  });

  it('block 块内重画的字:光标后的一个字形簇(CJK / 组合字符整个);行尾、空格、tab → 空', () => {
    const state = EditorState.create({ doc: 'ab\t 中e\u0301\nx' });
    expect(blockCursorGlyph(state, 0)).toBe('a');
    expect(blockCursorGlyph(state, 2)).toBe('');
    expect(blockCursorGlyph(state, 3)).toBe('');
    expect(blockCursorGlyph(state, 4)).toBe('中');
    expect(blockCursorGlyph(state, 5)).toBe('e\u0301');
    expect(blockCursorGlyph(state, 7)).toBe('');
    expect(blockCursorGlyph(state, 8)).toBe('x');
    expect(blockCursorGlyph(state, 9)).toBe('');
  });

  it('underline 2px 底边、underline-thin 1px、block-outline 1px 框,都无左边框、一个字符宽', () => {
    expect(cursorThemeSpec(opts({ style: 'underline' }))[C]).toMatchObject({ borderLeft: 'none', width: '1ch', borderBottom: '2px solid var(--md-on-surface)' });
    expect(cursorThemeSpec(opts({ style: 'underline-thin' }))[C]).toMatchObject({ borderBottom: '1px solid var(--md-on-surface)' });
    expect(cursorThemeSpec(opts({ style: 'block-outline' }))[C]).toMatchObject({ width: '1ch', border: '1px solid var(--md-on-surface)' });
    expect(cursorThemeSpec(opts({ style: 'line-thin' }))[C]).toMatchObject({ borderLeftWidth: 'min(1px, 1ch)' });
  });

  it('smooth / phase / expand 用各自关键帧(expand 作用在光标上、层不闪);blink 用 CodeMirror 自带', () => {
    const layer = '&.cm-focused > .cm-scroller > .cm-cursorLayer';
    const smooth = cursorThemeSpec(opts({ blinking: 'smooth' }));
    expect(smooth[layer]).toEqual({ animation: 'wm-cursor-smooth 1000ms ease-in-out infinite !important' });
    expect(smooth['@keyframes wm-cursor-smooth']).toEqual({ '0%, 10%, 90%, 100%': { opacity: '1' }, '30%, 70%': { opacity: '0' } });
    expect(cursorThemeSpec(opts({ blinking: 'phase' }))['@keyframes wm-cursor-phase']).toBeDefined();
    const expand = cursorThemeSpec(opts({ blinking: 'expand' }));
    expect(expand[layer]).toEqual({ animation: 'none !important' });
    expect(expand[`${layer} .cm-cursor, ${layer} .cm-blockCursor`]).toEqual({ animation: 'wm-cursor-expand 1000ms ease-in-out infinite !important' });
    expect(Object.keys(cursorThemeSpec(opts()))).not.toContain(layer);
  });

  it('同一组选项复用同一扩展实例(设置不变时 reconfigure 不换样式模块)', () => {
    expect(editorCursor(opts())).toBe(editorCursor(opts()));
    expect(editorCursor(opts({ width: 3 }))).not.toBe(editorCursor(opts()));
  });

  it('代码编辑器与冲突比较经 Compartment 接入并随设置 reconfigure', () => {
    for (const f of ['CodeEditor.tsx', 'ConflictDiffPanel.tsx']) {
      const s = src(`src/panels/Editor/${f}`);
      expect(s, f).toContain('cursorCompartment.current.of(editorCursor(');
      expect(s, f).toContain('cursorCompartment.current.reconfigure(editorCursor(cursorOptions))');
    }
  });
});

describe('Markdown 编辑模式(原生光标)', () => {
  it('caret-shape:块类 → block,下划线类 → underscore,其余 bar;solid → caret-animation: manual', () => {
    expect(nativeCaretStyle(opts())).toEqual({ caretShape: 'bar' });
    expect(nativeCaretStyle(opts({ style: 'block-outline' }))).toEqual({ caretShape: 'block' });
    expect(nativeCaretStyle(opts({ style: 'underline-thin', blinking: 'solid' }))).toEqual({
      caretShape: 'underscore',
      caretAnimation: 'manual',
    });
    expect(src('src/panels/Editor/MilkdownEditor.tsx')).toContain('nativeCaretStyle(useEditorCursorOptions())');
  });
});
