// BDD: editor-search-git-decorations / 对比度:--md-git-* 对 tab 栏 / 激活 tab / 悬停 tab / 搜索选中与悬停行底,两主题 ≥ 4.5
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf-8');
const block = (css: string, sel: ':root' | '.dark'): string =>
  css.match(new RegExp(`${sel === ':root' ? ':root' : '\\.dark'}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
const tokenValue = (sel: ':root' | '.dark', name: string): string => {
  for (const file of ['styles/design-tokens.css', 'styles/theme.css']) {
    const m = block(read(file), sel).match(new RegExp(`${name}:\\s*([^;]+);`));
    if (m) return m[1]!.trim();
  }
  return '';
};
type Rgba = [number, number, number, number];
const parse = (v: string): Rgba => {
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgba = v.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  throw new Error(`unparsed color ${v}`);
};
const over = (fg: Rgba, bg: Rgba, alpha = fg[3]): Rgba =>
  [0, 1, 2].map((i) => alpha * fg[i]! + (1 - alpha) * bg[i]!).concat(1) as Rgba;
const lum = (c: Rgba): number => {
  const [r, g, b] = c.slice(0, 3).map((x) => {
    const s = x / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: Rgba, b: Rgba): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const KINDS = ['modified', 'added', 'untracked', 'deleted', 'conflict', 'ignored'] as const;

describe('git 装饰色在 tab / 搜索行背景上的对比度', () => {
  it('TabNav 的激活 / 悬停底取自 surface-container-high / state-hover;搜索行选中 / 悬停为 accent/15 / accent/10', async () => {
    const tabCss = read('design/TabNav.css');
    expect(tabCss).toMatch(/\.wm-tab-nav-item\[data-active="true"\]\s*\{[^}]*background-color:\s*var\(--md-surface-container-high\)/);
    expect(tabCss).toMatch(/\.wm-tab-nav-item:hover\s*\{[^}]*background-color:\s*var\(--md-state-hover\)/);
    const { pickerRowClassName } = await import('../../plugins/picker/picker-row');
    expect(pickerRowClassName(true)).toContain('bg-accent/15');
    expect(pickerRowClassName(false)).toContain('hover:bg-accent/10');
  });

  for (const sel of [':root', '.dark'] as const) {
    it(`${sel}:每种状态色 ≥ 4.5`, () => {
      const surface = parse(tokenValue(sel, '--md-surface'));
      const primary = parse(tokenValue(sel, '--md-primary'));
      const backgrounds: Record<string, Rgba> = {
        canvas: surface,
        activeTab: parse(tokenValue(sel, '--md-surface-container-high')),
        hoverTab: over(parse(tokenValue(sel, '--md-state-hover')), surface),
        searchSelected: over(primary, surface, 0.15),
        searchHover: over(primary, surface, 0.1),
      };
      for (const kind of KINDS) {
        const fg = parse(tokenValue(sel, `--md-git-${kind}`));
        for (const [name, bg] of Object.entries(backgrounds)) {
          expect(contrast(fg, bg), `${sel} ${kind} on ${name}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
