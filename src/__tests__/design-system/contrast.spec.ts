// 关键 token 组合的对比度守护(WCAG 1.4.3 文字 ≥ 4.5、1.4.11 图形 ≥ 3)。值取自 design-tokens.css / theme.css 的
// :root(light)与 .dark,半透明叠层按 alpha 合成到 --md-surface 上再算。BDD 见 color-vision-cues/README 第 6 条。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(resolve(__dirname, '../..', rel), 'utf-8');
const TOKENS = read('styles/design-tokens.css');
const THEME = read('styles/theme.css');

const block = (css: string, sel: ':root' | '.dark'): string =>
  css.match(new RegExp(`${sel === ':root' ? ':root' : '\\.dark'}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';

type Rgba = readonly [number, number, number, number];

function parse(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1]!;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1) as unknown as Rgba;
  }
  const rgba = value.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  throw new Error(`unparsed color ${value}`);
}

function token(theme: 'light' | 'dark', name: string): Rgba {
  const sel = theme === 'light' ? ':root' : '.dark';
  for (const css of [THEME, TOKENS]) {
    const m = block(css, sel).match(new RegExp(`${name}:\\s*([^;]+);`));
    if (m) return parse(m[1]!.trim());
  }
  throw new Error(`${theme} ${name} missing`);
}

/** fg 按 alpha 叠到不透明 bg 上。 */
const over = (fg: Rgba, bg: Rgba): Rgba =>
  [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3])).concat(1) as unknown as Rgba;
const lum = (c: Rgba): number => {
  const [r, g, b] = [0, 1, 2].map((i) => {
    const v = c[i]! / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: Rgba, b: Rgba): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const SYNTAX = ['keyword', 'name', 'function', 'constant', 'definition', 'type', 'operator', 'comment', 'string'] as const;

describe.each(['dark', 'light'] as const)('%s:代码编辑器语法色叠在各行底色上', (theme) => {
  const surface = token(theme, '--md-surface');
  const backgrounds = {
    surface,
    当前行: over(token(theme, '--md-state-hover'), surface),
    调试执行行: over(token(theme, '--md-debug-exec-line'), surface),
  };
  for (const [label, bg] of Object.entries(backgrounds)) {
    it.each(SYNTAX)(`--md-syntax-%s 在${label}上 ≥ 4.5`, (name) => {
      expect(contrast(token(theme, `--md-syntax-${name}`), bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('选区(--md-editor-selection):注释 ≥ 4.5、正文 ≥ 7、其余语法色 ≥ 4;选区对画布仍可辨(≥ 1.2)', () => {
    const sel = over(token(theme, '--md-editor-selection'), surface);
    expect(contrast(token(theme, '--md-syntax-comment'), sel)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(theme, '--md-on-surface'), sel)).toBeGreaterThanOrEqual(7);
    for (const name of SYNTAX) expect(contrast(token(theme, `--md-syntax-${name}`), sel), name).toBeGreaterThanOrEqual(4);
    expect(contrast(sel, surface)).toBeGreaterThanOrEqual(1.2);
  });

  it('编辑器选区取 --md-editor-selection(不再是 primary 28%)', () => {
    const src = read('panels/Editor/code-editor-theme.ts');
    expect(src).toContain("const SELECTION = 'var(--md-editor-selection)';");
  });
});

describe.each(['dark', 'light'] as const)('%s:图形与占位文字', (theme) => {
  const SURFACES = [
    '--md-surface',
    '--md-surface-container-low',
    '--md-surface-container',
    '--md-surface-container-high',
    '--md-surface-container-highest',
  ];
  it.each(SURFACES)('调试执行箭头(--md-debug-exec-marker)对 %s ≥ 3', (bg) => {
    expect(contrast(token(theme, '--md-debug-exec-marker'), token(theme, bg))).toBeGreaterThanOrEqual(3);
  });

  it('占位文字(design Input / 编辑器查找框)用 --md-fg-dim,对 surface / container-low / container ≥ 4.5', () => {
    expect(read('design/Input.css')).toMatch(/\.wm-input::placeholder\s*\{\s*color:\s*var\(--md-fg-dim\)/);
    expect(read('panels/Editor/code-editor-theme.ts')).toContain("'.cm-textfield::placeholder': { color: 'var(--md-fg-dim)' }");
    for (const bg of SURFACES.slice(0, 3)) {
      expect(contrast(token(theme, '--md-fg-dim'), token(theme, bg)), bg).toBeGreaterThanOrEqual(4.5);
    }
  });
});
