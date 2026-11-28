// @vitest-environment jsdom
// BDD:色觉 / 强制颜色下的非颜色线索 —— 调试装饰与编辑器高亮的 forced-colors 规则(契约 1、2)。见同目录 README。
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { codeEditorTheme } from '../../panels/Editor/code-editor-theme';
import { debugDecorationsExtension } from '../../panels/Editor/decorations/debug-decorations';
import { indentGuides } from '../../panels/Editor/codemirror-editor-guides';

beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
});

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = '';
});

function mountCss(resolved: 'light' | 'dark'): string {
  const parent = document.createElement('div');
  document.body.append(parent);
  view = new EditorView({
    state: EditorState.create({
      doc: 'if (a) {\n  b();\n}\n',
      extensions: [codeEditorTheme(resolved), debugDecorationsExtension(), indentGuides],
    }),
    parent,
  });
  return [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n').replace(/\s+/g, ' ');
}

/** 所有 @media (forced-colors: active) 块的内部文本(按括号配对)。 */
function forcedBlocks(css: string): string {
  const out: string[] = [];
  const re = /@media \(forced-colors: active\) ?\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    out.push(css.slice(start, i - 1));
  }
  return out.join(' ');
}

/** 选择器以 suffix 结尾(去掉主题作用域类后精确比较)的规则体。 */
function bodyOf(block: string, suffix: string): string {
  return Array.from(block.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter((m) => m[1]!.split(',').some((sel) => sel.trim().replace(/^\.ͼ\w+\s*/, '') === suffix))
    .map((m) => m[2]!)
    .join(' ');
}

describe.each(['dark', 'light'] as const)('%s:强制颜色下的调试装饰', (resolved) => {
  it('断点红点 CanvasText、执行箭头 Highlight、箭头里的红点 HighlightText(都 forced-color-adjust: none)', () => {
    const fc = forcedBlocks(mountCss(resolved));
    const bp = bodyOf(fc, '.cm-debug-breakpoint-marker');
    expect(bp).toMatch(/forced-color-adjust: none/);
    expect(bp).toMatch(/background-color: CanvasText/);
    const arrow = bodyOf(fc, '.cm-debug-exec-marker');
    expect(arrow).toMatch(/forced-color-adjust: none/);
    expect(arrow).toMatch(/background-color: Highlight/);
    const inner = bodyOf(fc, '.cm-debug-exec-marker.cm-debug-exec-on-breakpoint::after');
    expect(inner).toMatch(/forced-color-adjust: none/);
    expect(inner).toMatch(/background-color: HighlightText/);
  });

  it('执行行:1px Highlight 实线轮廓(底色交给系统)', () => {
    const fc = forcedBlocks(mountCss(resolved));
    expect(bodyOf(fc, '.cm-line.cm-debug-exec-line')).toMatch(/outline: 1px solid Highlight/);
  });

  it('正常模式:箭头里的断点红点外描一圈画布色(红 / 黄亮度接近,色盲下靠这圈分开)', () => {
    const css = mountCss(resolved);
    const normal = css.replace(/@media \(forced-colors: active\) ?\{[^@]*?\}\s*\}/g, '');
    expect(bodyOf(normal, '.cm-debug-exec-marker.cm-debug-exec-on-breakpoint::after')).toMatch(
      /box-shadow: 0 0 0 1px var\(--md-surface\)/,
    );
  });
});

describe.each(['dark', 'light'] as const)('%s:强制颜色下的出现处 / 括号 / 缩进参考线', (resolved) => {
  it('出现处 1px 点线 CanvasText(VSCode HC selectionHighlightBorder dotted),匹配括号 1px 实线 CanvasText', () => {
    const fc = forcedBlocks(mountCss(resolved));
    expect(bodyOf(fc, '.cm-selectionMatch')).toMatch(/outline: 1px dotted CanvasText/);
    expect(bodyOf(fc, '.cm-matchingBracket')).toMatch(/outline: 1px solid CanvasText/);
  });

  it('缩进参考线:普通 GrayText、当前块 CanvasText,伪元素 forced-color-adjust: none 保住渐变', () => {
    const fc = forcedBlocks(mountCss(resolved));
    const vars = bodyOf(fc, '.cm-indent-markers');
    expect(vars).toMatch(/--indent-marker-bg-color: GrayText/);
    expect(vars).toMatch(/--indent-marker-active-bg-color: CanvasText/);
    expect(bodyOf(fc, '.cm-indent-markers::before')).toMatch(/forced-color-adjust: none/);
  });

  it('@media 块里的规则都挂在主题类下(没有把「@media (…)」当选择器前缀的无效规则)', () => {
    expect(mountCss(resolved)).not.toMatch(/@media \(forced-colors: active\)\s*[.&]/);
  });
});
