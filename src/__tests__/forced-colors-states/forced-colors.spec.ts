// BDD:强制颜色模式下的选中 / 高亮 / 按下状态。见同目录 README。
// jsdom 不计算 @media 规则 → 按 CSS 源码钉契约;真实计算样式见 tests/e2e/forced-colors-states.spec.ts。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 取文件内所有 `@media (forced-colors: active) { … }` 块的内部文本(按括号配对),多块拼接。 */
function forcedBlock(src: string): string {
  const out: string[] = [];
  const re = /@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out.join('\n');
}

/** 块内规则:选择器(逗号拆分、压空白)→ 声明体。 */
function rules(block: string): Array<{ selectors: string[]; body: string }> {
  return Array.from(block.matchAll(/([^{}]+)\{([^}]*)\}/g), (m) => ({
    selectors: splitSelectors(m[1]!),
    body: m[2]!,
  }));
}

/** 顶层逗号拆分(不拆 :is() / :not() 内的逗号)。 */
function splitSelectors(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.replace(/\s+/g, '')).filter(Boolean);
}

/** 块内命中某选择器(精确)的声明体,多条拼接。 */
function bodyOf(block: string, selector: string): string {
  return rules(block)
    .filter((r) => r.selectors.includes(selector.replace(/\s+/g, '')))
    .map((r) => r.body)
    .join('\n');
}

const SEMANTIC_STATES = [
  '[aria-selected="true"]',
  '[aria-current]:not([aria-current="false"])',
  '[aria-pressed="true"]',
  '[data-highlighted]',
  '[data-state="active"]',
  '[data-active="true"]',
];

describe('强制颜色:统一语义状态规则(src/styles/forced-colors.css)', () => {
  const SRC = css('src/styles/forced-colors.css');
  const FC = forcedBlock(SRC);

  it('整个文件只有 forced-colors 块(正常模式零影响)', () => {
    expect(FC).not.toBe('');
    const outside = SRC.replace(/@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{[\s\S]*\}\s*$/, '').trim();
    expect(outside).toBe('');
  });

  it.each(SEMANTIC_STATES)('%s → 内嵌 2px Highlight 轮廓', (sel) => {
    const body = bodyOf(FC, sel);
    expect(body).toMatch(/outline:\s*2px solid Highlight/);
    expect(body).toMatch(/outline-offset:\s*-2px/);
  });

  it('选中项同时键盘聚焦 → 虚线(与仅选中实线可区分),菜单高亮项不参与', () => {
    const focusRule = rules(FC).find((r) => r.selectors.some((s) => s.endsWith(':focus-visible')));
    expect(focusRule?.body).toMatch(/outline-style:\s*dashed/);
    const sel = focusRule!.selectors.join(',');
    expect(sel).toContain('[aria-selected="true"]');
    expect(sel).toContain('[aria-pressed="true"]');
    expect(sel).not.toContain('[data-highlighted]');
  });

  it('透明占位边框(.border-transparent)改 Canvas,不再每行显示竖条', () => {
    expect(bodyOf(FC, '.border-transparent')).toMatch(/border-color:\s*Canvas\b/);
  });

  it('dock 活动 tab 顶部强调条:forced-color-adjust: none + Highlight 背景', () => {
    const body = bodyOf(FC, '[role="tab"] > .bg-accent');
    expect(body).toMatch(/forced-color-adjust:\s*none/);
    expect(body).toMatch(/background-color:\s*Highlight/);
  });

  it('以非 layer 方式在 design 之后导入(压过组件 outline: none 与 utilities)', () => {
    const tw = css('src/styles/tailwind.css');
    const designAt = tw.indexOf('../design/index.css');
    const fcLine = tw.split('\n').find((l) => l.includes('forced-colors.css'));
    expect(fcLine).toBeDefined();
    expect(fcLine).not.toMatch(/layer/);
    expect(tw.indexOf('forced-colors.css')).toBeGreaterThan(designAt);
  });
});

describe('强制颜色:design 组件专有部件', () => {
  it('Switch:关 CanvasText 描边 + 滑块;开 Highlight 轨道 + HighlightText 滑块;焦点 CanvasText', () => {
    const FC = forcedBlock(css('src/design/Switch.css'));
    expect(bodyOf(FC, '.wm-switch')).toMatch(/border-color:\s*CanvasText/);
    const thumb = bodyOf(FC, '.wm-switch__thumb');
    expect(thumb).toMatch(/forced-color-adjust:\s*none/);
    expect(thumb).toMatch(/background-color:\s*CanvasText/);
    const on = bodyOf(FC, '.wm-switch[data-checked="true"]');
    expect(on).toMatch(/forced-color-adjust:\s*none/);
    expect(on).toMatch(/background-color:\s*Highlight/);
    expect(on).toMatch(/border-color:\s*Highlight/);
    expect(bodyOf(FC, '.wm-switch[data-checked="true"] .wm-switch__thumb')).toMatch(
      /background-color:\s*HighlightText/,
    );
    expect(bodyOf(FC, '.wm-switch:focus-visible')).toMatch(/outline-color:\s*CanvasText/);
  });

  it.each([
    ['src/design/Tabs.css', '.wm-tab-button', 'border-left-color'],
    ['src/design/TabNav.css', '.wm-tab-nav-item', 'border-bottom-color'],
    ['src/design/SegmentedControl.css', '.wm-segmented-option', 'border-color'],
  ])('%s:未选中透明边框 → Canvas,选中 → Highlight', (file, base, prop) => {
    const FC = forcedBlock(css(file));
    expect(bodyOf(FC, base)).toMatch(new RegExp(`${prop}:\\s*Canvas\\b`));
    expect(bodyOf(FC, `${base}[data-active="true"]`)).toMatch(new RegExp(`${prop}:\\s*Highlight`));
  });

  it('NavRailButton 激活条 Highlight;TabNav 未保存圆点 CanvasText', () => {
    const rail = bodyOf(forcedBlock(css('src/design/NavRailButton.css')), '.wm-nav-rail-button__active-bar');
    expect(rail).toMatch(/forced-color-adjust:\s*none/);
    expect(rail).toMatch(/background-color:\s*Highlight/);
    const dot = bodyOf(forcedBlock(css('src/design/TabNav.css')), '.wm-tab-nav-item__dirty-dot');
    expect(dot).toMatch(/forced-color-adjust:\s*none/);
    expect(dot).toMatch(/background-color:\s*CanvasText/);
  });

  it('MenuItem:原生聚焦 2px Highlight 实线,悬停 1px Highlight 虚线', () => {
    const FC = forcedBlock(css('src/design/MenuItem.css'));
    expect(bodyOf(FC, '.wm-menu-item:focus-visible:not(:disabled)')).toMatch(/outline:\s*2px solid Highlight/);
    expect(bodyOf(FC, '.wm-menu-item:hover:not(:disabled)')).toMatch(/outline:\s*1px dashed Highlight/);
  });
});
