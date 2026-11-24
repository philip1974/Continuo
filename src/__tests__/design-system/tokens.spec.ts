import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
    const own = ['--md-debug-breakpoint:', '--md-debug-exec-line:', '--md-fg-dim:', '--md-rating:'];
    const light = extractMdVars(getRootBlock(LM_THEME));
    const dark = extractMdVars(getDarkBlock(LM_THEME));
    for (const v of own) {
      expect(light).toContain(v);
      expect(dark).toContain(v);
    }
  });

  it('theme.css 自有 --md-* 槽位(含 --md-syntax-*)在 :root 与 .dark 名称集合一致', () => {
    const light = new Set(extractMdVars(getRootBlock(LM_THEME)));
    const dark = new Set(extractMdVars(getDarkBlock(LM_THEME)));
    expect(light.has('--md-syntax-keyword:')).toBe(true);
    expect([...light].sort()).toEqual([...dark].sort());
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

// 终端背景 / 窗口首帧底色 = 画布色(--md-surface)。三处须用字面 hex(xterm 只收 #RRGGBB;BrowserWindow 在 renderer
// 绘制前就要底色),故钉住与 token 一致,改画布色时此处提醒同步。
describe('终端与窗口底色跟随画布色(--md-surface)', () => {
  const surface = (block: string): string => block.match(/--md-surface:\s*(#[0-9a-f]{6});/i)?.[1] ?? '';
  const read = (rel: string): string => readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

  it('终端 DARK_THEME / LIGHT_THEME 的 background = .dark / :root 的 --md-surface', () => {
    const src = read('panels/Terminal/useTerminal.ts');
    const bg = (name: string): string =>
      src.match(new RegExp(`const ${name}: ITheme = \\{[\\s\\S]*?background: '(#[0-9a-f]{6})'`, 'i'))?.[1] ?? '';
    expect(bg('DARK_THEME')).toBe(surface(getDarkBlock(DESIGN_TOKENS)));
    expect(bg('LIGHT_THEME')).toBe(surface(getRootBlock(DESIGN_TOKENS)));
  });

  it('窗口首帧底色(WINDOW_BACKGROUND_COLORS,按主题)= .dark / :root 的 --md-surface', () => {
    const src = read('../electron/shared/window-background.ts');
    const color = (k: string): string =>
      src.match(new RegExp(`${k}: '(#[0-9a-f]{6})'`, 'i'))?.[1] ?? '';
    expect(color('dark')).toBe(surface(getDarkBlock(DESIGN_TOKENS)));
    expect(color('light')).toBe(surface(getRootBlock(DESIGN_TOKENS)));
    // 两处窗口都经 currentWindowBackgroundColor()(详见 window-background-theme/)
    expect(read('../electron/main/index.ts')).not.toMatch(/backgroundColor:\s*'#/);
  });
});


// 次要弱化文字(--md-fg-dim)大量用作 10–12px 正文(状态栏 / 版本号 / 单位等),须在两主题的常用承载面
// (canvas / panel / hover)上达到 WCAG AA 正文 4.5:1;两主题各自取值(不能共用一个灰)。
describe('--md-fg-dim 正文对比度', () => {
  const hex = (block: string, name: string): string =>
    block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, 'i'))?.[1] ?? '';
  const lum = (h: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) =>
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  for (const [theme, pick] of [
    ['light', getRootBlock],
    ['dark', getDarkBlock],
  ] as const) {
    it(`${theme}:fg-dim 对 surface / surface-container / surface-container-high ≥ 4.5`, () => {
      const fgDim = hex(pick(LM_THEME), '--md-fg-dim');
      expect(fgDim).toMatch(/^#[0-9a-f]{6}$/i);
      for (const bg of ['--md-surface', '--md-surface-container', '--md-surface-container-high']) {
        expect(contrast(fgDim, hex(pick(DESIGN_TOKENS), bg)), `${theme} ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('fg-dim / fg-muted 文字不叠透明度(text-fg-dim/60 等会把对比压到 AA 以下)', () => {
    const files = execFileSync('git', ['ls-files', 'src/*.tsx', 'src/*.ts'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f !== '' && !f.includes('__tests__'));
    const hits = files.flatMap((f) =>
      (readFileSync(resolve(process.cwd(), f), 'utf-8').match(/\btext-fg-(?:dim|muted)\/\d+/g) ?? []).map(
        (m) => `${f}: ${m}`,
      ),
    );
    expect(hits).toEqual([]);
  });
});

// 评分星(MD3 无对应槽):Continuo 自有 --md-rating。暗色沿用业内约定琥珀色,亮色另取深琥珀 —— Tailwind amber-400
// 在亮色底上仅 1.63:1。两主题对常用承载面 ≥ 4.5,经 @theme inline 暴露为 text-rating。
describe('--md-rating 评分色', () => {
  const hex = (block: string, name: string): string =>
    block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, 'i'))?.[1] ?? '';
  const lum = (h: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) =>
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  for (const [theme, pick] of [
    ['light', getRootBlock],
    ['dark', getDarkBlock],
  ] as const) {
    it(`${theme}:rating 对 surface / surface-container-low / surface-container ≥ 4.5`, () => {
      const rating = hex(pick(LM_THEME), '--md-rating');
      expect(rating).toMatch(/^#[0-9a-f]{6}$/i);
      for (const bg of ['--md-surface', '--md-surface-container-low', '--md-surface-container']) {
        expect(contrast(rating, hex(pick(DESIGN_TOKENS), bg)), `${theme} ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('@theme inline 暴露 --color-rating: var(--md-rating)', () => {
    expect(LM_THEME).toMatch(/--color-rating:\s*var\(--md-rating\);/);
  });

  it('组件不用 Tailwind 默认色板(text-amber-400 等),统一走语义 token', () => {
    const files = execFileSync('git', ['ls-files', 'src/*.tsx', 'src/*.ts'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f !== '' && !f.includes('__tests__'));
    const re =
      /\b(?:text|bg|border|ring|fill|stroke)-(?:amber|yellow|red|green|blue|sky|neutral|gray|slate|zinc|stone|orange|emerald|lime|teal|cyan|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
    const hits = files.flatMap((f) =>
      (readFileSync(resolve(process.cwd(), f), 'utf-8').match(re) ?? []).map((m) => `${f}: ${m}`),
    );
    expect(hits).toEqual([]);
  });
});

// 键盘焦点环(对齐 VSCode focusBorder):两主题同一语义 —— 独立于强调色(primary)的蓝,而不是一主题用主色紫、
// 另一主题用 royal blue。须对两主题的承载面阶梯(canvas → surface-container-highest)≥ 3:1(WCAG 1.4.11 非文本)。
describe('--md-focus-ring 焦点环', () => {
  const hex = (block: string, name: string): string =>
    block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, 'i'))?.[1] ?? '';
  const lum = (h: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) =>
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const hue = (h: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return 0;
    const raw = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (raw * 60 + 360) % 360;
  };

  for (const [theme, pick] of [
    ['light', getRootBlock],
    ['dark', getDarkBlock],
  ] as const) {
    const block = pick(DESIGN_TOKENS);
    const ring = hex(block, '--md-focus-ring');

    it(`${theme}:焦点环是独立于 primary 的 focusBorder 蓝`, () => {
      expect(ring).toMatch(/^#[0-9a-f]{6}$/i);
      expect(hue(ring)).toBeGreaterThanOrEqual(195);
      expect(hue(ring)).toBeLessThanOrEqual(225);
      expect(ring.toLowerCase()).not.toBe(hex(block, '--md-primary').toLowerCase());
    });

    it(`${theme}:焦点环对 surface 阶梯 ≥ 3:1`, () => {
      for (const bg of [
        '--md-surface',
        '--md-surface-container-lowest',
        '--md-surface-container-low',
        '--md-surface-container',
        '--md-surface-container-high',
        '--md-surface-container-highest',
      ]) {
        expect(contrast(ring, hex(block, bg)), `${theme} ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
