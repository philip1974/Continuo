import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const NOUS_TOKENS = readFileSync(
  resolve(__dirname, '../../styles/nous-tokens.css'),
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

describe('nous-tokens.css MD3 完整性', () => {
  it(':root 与 .dark 下的 --md-* 数量严格相等', () => {
    const lightVars = extractMdVars(getRootBlock(NOUS_TOKENS));
    const darkVars = extractMdVars(getDarkBlock(NOUS_TOKENS));
    expect(lightVars.length).toBeGreaterThanOrEqual(40);
    expect(lightVars.length).toBe(darkVars.length);
  });

  it(':root 与 .dark 定义的 --md-* 名称集合完全一致', () => {
    const lightSet = new Set(extractMdVars(getRootBlock(NOUS_TOKENS)));
    const darkSet = new Set(extractMdVars(getDarkBlock(NOUS_TOKENS)));
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
      expect(NOUS_TOKENS.includes(slot)).toBe(true);
    }
  });
});

describe('theme.css Continuo 暗色覆盖与 @theme inline 链路', () => {
  it('引入 nous-tokens.css', () => {
    expect(LM_THEME).toMatch(/@import\s+['"]\.\/nous-tokens\.css['"]/);
  });

  it('.dark 块覆盖核心 surface / primary 槽位(Continuo slate + sky 身份)', () => {
    const lmDark = getDarkBlock(LM_THEME);
    expect(lmDark).toMatch(/--md-surface\s*:/);
    expect(lmDark).toMatch(/--md-primary\s*:/);
    expect(lmDark).toMatch(/--md-on-surface\s*:/);
  });

  it('@theme inline 暴露 9 个 --color-* 语义 token,全部 var(--md-*) 解析', () => {
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
    ];
    for (const t of colorTokens) {
      expect(inner).toMatch(new RegExp(`--color-${t}\\s*:`));
    }
    // fg-dim 是唯一允许的字面 hex(MD3 无对应 dim 槽);其余必须 var(--md-*)
    const lines = inner
      .split('\n')
      .filter((l) => l.includes('--color-') && !l.includes('fg-dim'));
    for (const line of lines) {
      expect(line).toMatch(/var\(--md-/);
    }
  });
});
