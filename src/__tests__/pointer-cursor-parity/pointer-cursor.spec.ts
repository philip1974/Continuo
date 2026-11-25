// BDD:可点击控件统一手形光标。见同目录 README。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../../styles/theme.css'), 'utf8');

/** theme.css 里所有 @layer base 块内声明 cursor: pointer 的规则选择器(逗号拆开、去空白)。 */
function basePointerSelectors(): string[] {
  const out: string[] = [];
  for (const layer of css.matchAll(/@layer\s+base\s*\{((?:[^{}]*\{[^}]*\})*[^{}]*)\}/g)) {
    for (const rule of layer[1]!.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/cursor:\s*pointer/.test(rule[2]!)) continue;
      out.push(...rule[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.replace(/\s+/g, '')));
    }
  }
  return out;
}

describe('可点击控件手形光标', () => {
  it('基础层给可用的按钮与 role=button 设 cursor: pointer', () => {
    const selectors = basePointerSelectors();
    expect(selectors).toContain('button:not(:disabled)');
    expect(selectors).toContain('[role="button"]:not([aria-disabled="true"])');
  });

  it('不命中文本输入 / 可编辑区域', () => {
    for (const s of basePointerSelectors()) {
      expect(s).not.toMatch(/input|textarea|contenteditable|\.cm-|xterm/);
    }
  });
});
