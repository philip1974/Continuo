import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DESIGN_TOKENS = readFileSync(
  resolve(__dirname, '../../styles/design-tokens.css'),
  'utf-8',
);
const LM_THEME = readFileSync(
  resolve(__dirname, '../../styles/theme.css'),
  'utf-8',
);

function extractMdVars(block: string): string[] {
  return Array.from(block.matchAll(/--md-[a-z-]+:/g)).map((m) => m[0]);
}

function getRootBlock(css: string): string {
  const m = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  return m?.[1] ?? '';
}

function getDarkBlock(css: string): string {
  const m = css.match(/\.dark\s*\{([\s\S]*?)\n\}/);
  return m?.[1] ?? '';
}

describe('design-tokens.css MD3 完整性', () => {
  it(':root 与 .dark 下的 --md-* 数量严格相等', () => {
    const lightVars = extractMdVars(getRootBlock(DESIGN_TOKENS));
    const darkVars = extractMdVars(getDarkBlock(DESIGN_TOKENS));
    expect(lightVars.length).toBeGreaterThanOrEqual(40);
    expect(lightVars.length).toBe(darkVars.length);
  });

  it(':root 与 .dark 定义的 --md-* 名称集合完全一致', () => {
    const lightSet = new Set(extractMdVars(getRootBlock(DESIGN_TOKENS)));
    const darkSet = new Set(extractMdVars(getDarkBlock(DESIGN_TOKENS)));
    expect([...lightSet].sort()).toEqual([...darkSet].sort());
  });

  it('必含 MD3 核心槽位 surface / primary / on-surface / outline / state-hover', () => {
    const required = [
      '--md-surface:',
      '--md-on-surface:',
      '--md-primary:',
      '--md-on-primary:',
      '--md-outline:',
      '--md-state-hover:',
    ];
    for (const slot of required) {
      expect(DESIGN_TOKENS.includes(slot)).toBe(true);
    }
  });
});

describe('theme.css 单层色板与 @theme inline 链路', () => {
  it('引入 design-tokens.css', () => {
    expect(LM_THEME).toMatch(/@import\s+['"]\.\/design-tokens\.css['"]/);
  });

  it('色板单层:theme.css 不覆盖 design-tokens.css 已定义的任何 --md-*', () => {
    const baseVars = new Set(extractMdVars(DESIGN_TOKENS));
    const themeOutsideMapping = LM_THEME.replace(/@theme\s+inline\s*\{[\s\S]*?\n\}/, '');
    const overridden = extractMdVars(themeOutsideMapping).filter((v) => baseVars.has(v));
    expect(overridden).toEqual([]);
  });

  it('design-tokens.css .dark 直接承载 Continuo IDE 暗色(蓝紫 surface + 淡天蓝 / royal blue primary)', () => {
    const dark = getDarkBlock(DESIGN_TOKENS);
    expect(dark).toMatch(/--md-surface:\s*#11131b;/);
    expect(dark).toMatch(/--md-primary:\s*#b4c5ff;/);
    expect(dark).toMatch(/--md-primary-container:\s*#2563eb;/);
    expect(dark).toMatch(/--md-on-surface:\s*#e1e2ed;/);
  });

  it('Continuo 自有 --md-* 槽位在 theme.css 的 :root 与 .dark 都给值', () => {
    const own = ['--md-debug-breakpoint:', '--md-debug-exec-line:', '--md-fg-dim:'];
    const light = extractMdVars(getRootBlock(LM_THEME));
    const dark = extractMdVars(getDarkBlock(LM_THEME));
    for (const v of own) {
      expect(light).toContain(v);
      expect(dark).toContain(v);
    }
  });

  it('@theme inline 暴露 14 个 --color-* 语义 token,全部 var(--md-*) 解析', () => {
    const themeBlock = LM_THEME.match(/@theme\s+inline\s*\{([\s\S]*?)\n\}/);
    expect(themeBlock).not.toBeNull();
    const inner = themeBlock![1] ?? '';
    const colorTokens = [
      'canvas',
      'panel',
      'panel-soft',
      'hover',
      'line',
      'fg',
      'fg-muted',
      'fg-dim',
      'accent',
      // demo (3) 配色双槽:accent (淡蓝,stroke / 文字 / alpha) +
      // accent-fill (royal blue,filled 控件强视觉) + on-accent-fill (filled 上的浅文字)
      'accent-fill',
      'on-accent-fill',
      // 状态色:取代散在组件里的 text-red-* / text-amber-* / bg-red-500 硬编码
      'error',
      'on-error',
      'warning',
    ];
    for (const t of colorTokens) {
      expect(inner).toMatch(new RegExp(`--color-${t}\\s*:`));
    }
    // 所有 --color-* 都必须解析自 var(--md-*)(含 fg-dim:MD3 无对应槽,由 theme.css 自定义 --md-fg-dim 承载)
    const lines = inner.split('\n').filter((l) => l.includes('--color-'));
    for (const line of lines) {
      expect(line).toMatch(/var\(--md-/);
    }
  });
});
