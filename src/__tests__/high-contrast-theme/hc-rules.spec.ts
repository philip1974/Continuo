// BDD: high-contrast-theme —— HC 专有边框规则的具体取值(README「4. HC 专有边框」):对话框 / 工具栏 ghost 按钮边框、
// 当前行与调试执行行 / Milkdown 内嵌代码块、Milkdown 分隔线 / 引用竖条、dock tab 键盘焦点。真实绘制由
// tests/e2e/high-contrast-polish.spec.ts 守护(计算样式 + 像素)。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HC_CSS = readFileSync(resolve(__dirname, '../../styles/high-contrast.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
const PREFIX = ':root:is(.hc-black, .hc-light) ';

/** 顶层逗号分割(括号内的逗号不算)。 */
function splitSelectors(list: string): string[] {
  let depth = 0;
  let cur = '';
  const parts: string[] = [];
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim().replace(/\s+/g, ' '));
      cur = '';
    } else cur += ch;
  }
  parts.push(cur.trim().replace(/\s+/g, ' '));
  return parts;
}

const RULES = [...HC_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: splitSelectors(m[1]!),
  body: m[2]!.replace(/\s+/g, ' '),
}));

/** 选择器列表里含 PREFIX + sel 的全部规则体。 */
function bodyOf(sel: string): string {
  return RULES.filter((r) => r.selectors.includes(PREFIX + sel))
    .map((r) => r.body)
    .join(' ');
}

describe('HC:对话框 / 工具栏里的 ghost 文字按钮画 contrastBorder(VSCode button.secondaryBorder)', () => {
  it('.wm-modal-content / [role="toolbar"] 内的 ghost 按钮', () => {
    expect(bodyOf(':is(.wm-modal-content, [role="toolbar"]) .wm-button[data-variant="ghost"]')).toMatch(
      /border-color: var\(--md-contrast-border\)/,
    );
  });
  it('其它位置的 ghost(列表项 / 标题栏)不画常驻边框:没有不限上下文的 ghost 边框规则', () => {
    expect(bodyOf('.wm-button[data-variant="ghost"]')).toBe('');
    expect(bodyOf('.wm-button')).toBe('');
  });
});

describe('HC:CodeMirror 当前行', () => {
  it('当前行透明底不作用于调试执行行(执行行淡底保留)', () => {
    expect(bodyOf('.cm-editor .cm-activeLine:not(.cm-debug-exec-line)')).toMatch(/background-color: transparent/);
    // 不存在会盖住执行行底色的无条件透明底
    for (const r of RULES) {
      if (/background-color: transparent/.test(r.body)) {
        for (const s of r.selectors) expect(s.endsWith('.cm-activeLine'), s).toBe(false);
      }
    }
  });
  it('普通编辑器失焦也画当前行边框;Milkdown 内嵌代码块只在可编辑且获焦时画', () => {
    expect(bodyOf('.cm-editor:not(.milkdown .cm-editor) .cm-activeLine')).toMatch(
      /outline: 1px solid var\(--md-contrast-active-border\)/,
    );
    expect(bodyOf('.milkdown .ProseMirror:not([contenteditable="false"]) .cm-editor.cm-focused .cm-activeLine')).toMatch(
      /outline: 1px solid var\(--md-contrast-active-border\)/,
    );
    expect(bodyOf('.cm-editor .cm-activeLine')).toBe('');
  });
});

describe('HC:Milkdown 分隔线 / 引用', () => {
  it('分隔线用前景色(≥ 3:1),选中用 contrastActiveBorder', () => {
    expect(bodyOf('.milkdown .ProseMirror hr')).toMatch(/background-color: var\(--md-on-surface\)/);
    expect(bodyOf('.milkdown .ProseMirror hr.ProseMirror-selectednode')).toMatch(
      /background-color: var\(--md-contrast-active-border\)/,
    );
  });
  it('引用只有一条竖条:Crepe 的 ::before 改前景色,不再另加 border-left', () => {
    expect(bodyOf('.milkdown .ProseMirror blockquote::before')).toMatch(/background: var\(--md-on-surface\)/);
    expect(bodyOf('.milkdown .ProseMirror blockquote')).not.toMatch(/border-left/);
  });
});

describe('HC:dock tab 键盘焦点', () => {
  it('::after 焦点框 2px,内层 role=tab 的选中轮廓让位(不叠双层)', () => {
    expect(bodyOf('.dockview-theme-abyss .dv-tab:has(:focus-visible)::after')).toMatch(/outline-width: 2px !important/);
    expect(bodyOf('.dockview-theme-abyss .dv-tab:has(:focus-visible) [role="tab"]')).toMatch(/outline: none/);
  });
});
