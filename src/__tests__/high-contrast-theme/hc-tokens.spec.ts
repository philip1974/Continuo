// BDD: high-contrast-theme —— 高对比度两套色板的对比度契约、默认主题输入框边界、HC 专有边框规则的作用域、终端 / 窗口底色。
// 见同目录 README「3. 色板」「4. HC 专有边框」。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, over, toHex } from '../_helpers/contrast';
import { WINDOW_BACKGROUND_COLORS } from '../../../electron/shared/window-background';

const read = (rel: string): string => readFileSync(resolve(__dirname, '../..', rel), 'utf-8');
const TOKENS = read('styles/design-tokens.css');
const THEME = read('styles/theme.css');
const HC_CSS = read('styles/high-contrast.css');

function block(css: string, selector: ':root' | '.dark' | '.hc-black' | '.hc-light'): string {
  const esc = selector.replace('.', '\\.');
  return css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
}

/** 某主题的完整 --md-* 取值(design-tokens.css 色板 + theme.css 自有槽位)。 */
function palette(selector: ':root' | '.dark' | '.hc-black' | '.hc-light'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const css of [TOKENS, THEME]) {
    for (const m of block(css, selector).matchAll(/(--md-[a-z-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

const HC = {
  hcDark: palette('.hc-black'),
  hcLight: palette('.hc-light'),
} as const;

const tok = (p: Record<string, string>, name: string): string => {
  const v = p[`--md-${name}`];
  if (v === undefined) throw new Error(`missing --md-${name}`);
  return v;
};

/** HC 下文字会落在的底色:画布 / 面板 / 悬停 / 最高容器 + 编辑器调试执行行底 + 编辑器选区底。 */
function textBackgrounds(p: Record<string, string>): Record<string, string> {
  const surface = tok(p, 'surface');
  return {
    surface,
    'surface-container-low': tok(p, 'surface-container-low'),
    'surface-container': tok(p, 'surface-container'),
    'surface-container-high': tok(p, 'surface-container-high'),
    'surface-container-highest': tok(p, 'surface-container-highest'),
    'state-hover@surface': toHex(over(tok(p, 'state-hover'), surface)),
    'debug-exec-line@surface': toHex(over(tok(p, 'debug-exec-line'), surface)),
    'editor-selection@surface': toHex(over(tok(p, 'editor-selection'), surface)),
  };
}

const TEXT_TOKENS = [
  'on-surface',
  'on-surface-variant',
  'fg-dim',
  'outline',
  'primary',
  'list-highlight',
  'error',
  'warning',
  'success',
  'info',
  'rating',
  'git-modified',
  'git-added',
  'git-untracked',
  'git-deleted',
  'git-conflict',
  'git-ignored',
  'syntax-keyword',
  'syntax-name',
  'syntax-function',
  'syntax-constant',
  'syntax-definition',
  'syntax-type',
  'syntax-operator',
  'syntax-comment',
  'syntax-string',
  'syntax-heading',
  'syntax-link',
  'syntax-invalid',
];

const UI_TOKENS = [
  'contrast-border',
  'contrast-active-border',
  'focus-ring',
  'outline-variant',
  'outline',
  'primary',
  'debug-breakpoint',
  'debug-exec-marker',
  'indent-guide',
  'indent-guide-active',
];

describe('高对比度色板:文字 ≥ 7:1', () => {
  for (const [theme, p] of Object.entries(HC)) {
    for (const name of TEXT_TOKENS) {
      it(`${theme}:--md-${name} 对全部 HC 文字承载面 ≥ 7`, () => {
        for (const [bgName, bg] of Object.entries(textBackgrounds(p))) {
          expect(contrastRatio(tok(p, name), bg), `${theme} ${name} on ${bgName}`).toBeGreaterThanOrEqual(7);
        }
      });
    }

    it(`${theme}:on-* 对各自容器 / 填充 ≥ 7`, () => {
      for (const [fg, bg] of [
        ['on-primary', 'primary'],
        ['on-primary-container', 'primary-container'],
        ['on-secondary-container', 'secondary-container'],
        ['on-tertiary-container', 'tertiary-container'],
        ['on-error-container', 'error-container'],
        ['on-warning-container', 'warning-container'],
        ['on-success-container', 'success-container'],
        ['on-info-container', 'info-container'],
      ] as const) {
        expect(contrastRatio(tok(p, fg), tok(p, bg)), `${theme} ${fg}/${bg}`).toBeGreaterThanOrEqual(7);
      }
    });
  }
});

describe('高对比度色板:UI 边界 ≥ 3:1', () => {
  for (const [theme, p] of Object.entries(HC)) {
    it(`${theme}:边框 / 焦点 / 调试标记 / 缩进参考线对 surface 阶梯 ≥ 3`, () => {
      const ladder = ['surface', 'surface-container-low', 'surface-container', 'surface-container-high', 'surface-container-highest'];
      for (const name of UI_TOKENS) {
        for (const bg of ladder) {
          expect(contrastRatio(tok(p, name), tok(p, bg)), `${theme} ${name} on ${bg}`).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it(`${theme}:按 VSCode 取 contrastBorder / contrastActiveBorder / focusBorder`, () => {
      const expected =
        theme === 'hcDark'
          ? { border: '#6fc3df', active: '#f38518', focus: '#f38518' }
          : { border: '#0f4a85', active: '#006bbd', focus: '#006bbd' };
      expect(tok(p, 'contrast-border')).toBe(expected.border);
      expect(tok(p, 'contrast-active-border')).toBe(expected.active);
      expect(tok(p, 'focus-ring')).toBe(expected.focus);
      // 全部 border-line 分隔线 = contrastBorder(panel.border / sideBar.border / editorGroup.border …)
      expect(tok(p, 'outline-variant')).toBe(expected.border);
    });
  }

  it('亮 / 暗主题的 contrast-border / contrast-active-border 为透明(VSCode null)', () => {
    for (const sel of [':root', '.dark'] as const) {
      const p = palette(sel);
      expect(tok(p, 'contrast-border'), sel).toBe('transparent');
      expect(tok(p, 'contrast-active-border'), sel).toBe('transparent');
    }
  });
});

describe('默认两主题:输入框 / 分段控件外框 ≥ 3:1', () => {
  it('Input / SegmentedControl / CodeMirror 查找框描边用 --md-outline(不是分隔线 outline-variant)', () => {
    expect(read('design/Input.css')).toMatch(/\.wm-input \{[^}]*border: 1px solid var\(--md-outline\);/);
    expect(read('design/SegmentedControl.css')).toMatch(/\.wm-segmented \{[^}]*border: 1px solid var\(--md-outline\);/);
    expect(read('panels/Editor/code-editor-theme.ts')).toMatch(/'\.cm-textfield': \{[^}]*border: '1px solid var\(--md-outline\)'/);
  });

  for (const sel of [':root', '.dark'] as const) {
    it(`${sel}:--md-outline 对输入框底(container-low / container)与周围(surface)≥ 3`, () => {
      const p = palette(sel);
      for (const bg of ['surface', 'surface-container-low', 'surface-container']) {
        expect(contrastRatio(tok(p, 'outline'), tok(p, bg)), `${sel} outline on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

describe('HC 专有边框规则(high-contrast.css)', () => {
  const rules = [...HC_CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1]!.trim());

  it('tailwind.css 在 forced-colors.css 之后引入(未分层)', () => {
    const entry = read('styles/tailwind.css');
    expect(entry).toMatch(/@import "\.\/forced-colors\.css";\s*\n@import "\.\/high-contrast\.css";/);
  });

  it('每条规则的每个选择器都限定在 :root:is(.hc-black, .hc-light) 下(亮 / 暗主题零影响)', () => {
    expect(rules.length).toBeGreaterThan(10);
    for (const selectorList of rules) {
      // 逗号只在顶层分割(:is / :where / :not 括号内的逗号不算)
      let depth = 0;
      let cur = '';
      const parts: string[] = [];
      for (const ch of selectorList) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          parts.push(cur.trim());
          cur = '';
        } else cur += ch;
      }
      parts.push(cur.trim());
      for (const sel of parts) expect(sel.startsWith(':root:is(.hc-black, .hc-light)'), sel).toBe(true);
    }
  });

  it('覆盖 VSCode HC 的关键边框:控件 / 对话框 / tab / 选中 / 悬停 / 焦点 / 链接 / 编辑器', () => {
    const all = rules.join('\n');
    for (const needle of [
      '.wm-input',
      '.wm-segmented',
      '.wm-button',
      '.wm-modal-content',
      '.toast',
      '.dv-tab',
      '.dv-inactive-group',
      '[aria-selected="true"]',
      '[data-highlighted]',
      ':hover',
      ':focus-visible',
      'a[href]',
      '.cm-activeLine',
      '.cm-activeLineGutter',
      '.cm-selectionBackground',
      '.cm-searchMatch',
      '.cm-selectionMatch',
      '.cm-matchingBracket',
      '.cm-debug-exec-line',
      '.cm-changedText',
      '.milkdown .ProseMirror a',
      '.co-find-match',
    ]) {
      expect(all, needle).toContain(needle);
    }
  });
});

describe('底色:窗口 / 终端 = HC 画布色', () => {
  it('WINDOW_BACKGROUND_COLORS.hcDark / hcLight = .hc-black / .hc-light 的 --md-surface', () => {
    expect(WINDOW_BACKGROUND_COLORS.hcDark).toBe(tok(HC.hcDark, 'surface'));
    expect(WINDOW_BACKGROUND_COLORS.hcLight).toBe(tok(HC.hcLight, 'surface'));
  });

  it('终端 HC_DARK_THEME / HC_LIGHT_THEME 的 background = 对应 --md-surface', () => {
    const src = read('panels/Terminal/useTerminal.ts');
    const bg = (name: string): string =>
      src.match(new RegExp(`const ${name}: ITheme = \\{[\\s\\S]*?background: '(#[0-9a-f]{6})'`, 'i'))?.[1] ?? '';
    expect(bg('HC_DARK_THEME')).toBe(tok(HC.hcDark, 'surface'));
    expect(bg('HC_LIGHT_THEME')).toBe(tok(HC.hcLight, 'surface'));
  });
});
