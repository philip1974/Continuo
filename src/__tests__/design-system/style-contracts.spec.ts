// design 组件的样式契约(jsdom 不解析组件 .css,故按源码钉规则):键盘焦点环、state layer 叠加等
// 视觉行为在各组件间须一致。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const css = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

/** 取某选择器(精确匹配,含伪类)对应规则体;多处出现时拼接。 */
function ruleBody(src: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[}\\s,])${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'gm');
  return Array.from(src.matchAll(re), (m) => m[1] ?? '').join('\n');
}

describe('Button 样式契约', () => {
  const BUTTON = css('src/design/Button.css');

  it('键盘焦点:.wm-button:focus-visible 给 2px focus-ring 轮廓(与 IconButton / SegmentedControl / TabNav 一致)', () => {
    const body = ruleBody(BUTTON, '.wm-button:focus-visible');
    expect(body).toMatch(/outline:\s*2px solid var\(--md-focus-ring\)/);
    expect(body).toMatch(/outline-offset:\s*\d+px/);
  });

  it('secondary hover 在原底色上叠加 state layer,不替换成半透明底色(否则 hover 反而变淡)', () => {
    const hover = ruleBody(BUTTON, '.wm-button[data-variant="secondary"]:hover:not(:disabled, [aria-disabled="true"])');
    expect(hover).not.toBe('');
    expect(hover).not.toMatch(/background-color:\s*var\(--md-state-hover\)/);
    expect(hover).toMatch(/background-image:\s*linear-gradient\(var\(--md-state-hover\),\s*var\(--md-state-hover\)\)/);
  });
});

describe('SegmentedControl 样式契约', () => {
  const SEG = css('src/design/SegmentedControl.css');

  it('轨道有 1px outline-variant 描边,与所在面板区分', () => {
    expect(ruleBody(SEG, '.wm-segmented')).toMatch(/border:\s*1px solid var\(--md-outline-variant\)/);
  });

  // 选中指示须对相邻色(轨道 surface-container-low)≥ 3:1(WCAG 1.4.11):secondary-container 底色本身与轨道
  // 只有 1.85(暗)/ 1.17(亮),故以 1px primary 描边承载指示(10.12 / 5.85),底色 + on-secondary-container 字辅助。
  it('选中项:secondary-container 底 + on-secondary-container 字 + primary 描边', () => {
    const active = ruleBody(SEG, '.wm-segmented-option[data-active="true"]');
    expect(active).toMatch(/background-color:\s*var\(--md-secondary-container\)/);
    expect(active).toMatch(/color:\s*var\(--md-on-secondary-container\)/);
    expect(active).toMatch(/border-color:\s*var\(--md-primary\)/);
    expect(active).not.toMatch(/surface-container-high/);
  });

  it('未选中项保留同宽透明描边,选中切换不抖动布局', () => {
    expect(ruleBody(SEG, '.wm-segmented-option')).toMatch(/border:\s*1px solid transparent/);
  });
});

describe('MenuItem 样式契约', () => {
  const MENU = css('src/design/MenuItem.css');

  it('Radix 菜单高亮([data-highlighted])与 hover / focus-visible 同为 state-hover 底', () => {
    expect(MENU).toMatch(/\.wm-menu-item\[data-highlighted\]:not\(:disabled\)[^{]*\{[^}]*background-color:\s*var\(--md-state-hover\)/);
  });

  it('trailing 靠右、弱化色', () => {
    const body = ruleBody(MENU, '.wm-menu-item__trailing');
    expect(body).toMatch(/margin-left:\s*auto/);
    expect(body).toMatch(/color:\s*var\(--md-fg-dim\)/);
  });
});

// 浮层(菜单 / 右键菜单 / 终端搜索条 / toast / 模态)阴影统一走 --wm-shadow-popover(Tailwind 侧 shadow-popover),
// 两主题各有取值;Tailwind 默认 shadow / shadow-xl 在暗色底上几乎不可见。
describe('浮层阴影统一 shadow-popover', () => {
  const SHADOW_UTILITY = /(?:^|[^\w-])(shadow(?:-[a-z0-9]+(?:\/\d+)?|-\[[^\]]+\])?)(?=[^\w-]|$)/gm;
  for (const file of [
    'src/panels/Explorer/ContextMenu.tsx',
    'src/lib/dropdown-menu.tsx',
    'src/panels/Terminal/TerminalSearchBar.tsx',
  ]) {
    it(`${file} 只用 shadow-popover`, () => {
      const used = Array.from(css(file).matchAll(SHADOW_UTILITY), (m) => m[1]);
      expect(used.length).toBeGreaterThan(0);
      expect(used.filter((u) => u !== 'shadow-popover')).toEqual([]);
    });
  }

  it('Toast.css 用 var(--wm-shadow-popover),不引用未定义的 --md-shadow-color', () => {
    const toast = css('src/notifications/Toast.css');
    expect(ruleBody(toast, '.toast')).toMatch(/box-shadow:\s*var\(--wm-shadow-popover\)/);
    expect(toast).not.toContain('--md-shadow-color');
  });

  it('Toast 关闭按钮 hover 有 state-hover 背景反馈(不再是 color: currentColor 空操作)', () => {
    const hover = ruleBody(css('src/notifications/Toast.css'), '.toast__dismiss:hover');
    expect(hover).toMatch(/background-color:\s*var\(--md-state-hover\)/);
    expect(hover).not.toMatch(/color:\s*currentColor/);
  });
});

describe('Badge 样式契约', () => {
  const BADGE = css('src/design/Badge.css');

  it('size=xs:矩形小圆角(4px)标签,字号不小于 --wm-text-2xs', () => {
    const xs = ruleBody(BADGE, '.wm-badge[data-size="xs"]');
    expect(xs).toMatch(/border-radius:\s*4px/);
    expect(BADGE).not.toMatch(/font-size:\s*[0-9]px/);
  });

  it('accent-soft:surface-container-high 底 + primary 字 / 描边(与其它 *-soft 同构)', () => {
    const body = ruleBody(BADGE, '.wm-badge[data-variant="accent-soft"]');
    expect(body).toMatch(/background-color:\s*var\(--md-surface-container-high\)/);
    expect(body).toMatch(/color:\s*var\(--md-primary\)/);
    expect(body).toMatch(/border-color:\s*var\(--md-primary\)/);
  });
});

// 小标签(设置项 id / 单位、插件 id、快捷键命令 id、市场 Verified / 维护者 / 新账号)统一 design Badge,
// 不再各自手写 rounded + bg-*/NN + px-1.5 py-0.5 一套;文字最小 text-2xs(10px)。
describe('徽标统一 design Badge', () => {
  const HAND_CHIP = /rounded bg-(?:panel-soft|accent|warning)(?:\/\d+)? px-1(?:\.5)? py-0\.5/;
  for (const file of [
    'src/marketplace/MarketplaceTab.tsx',
    'src/plugins/settings/SettingItemRow.tsx',
    'src/plugins/settings/PluginsTabContent.tsx',
    'src/plugins/settings/KeybindingsTabContent.tsx',
  ]) {
    it(`${file} 不手写徽标,用 <Badge`, () => {
      const src = css(file);
      expect(src).not.toMatch(HAND_CHIP);
      expect(src).toMatch(/<Badge\b/);
    });
  }

  it('src 不出现小于 10px 的任意字号(text-[9px] 等)', () => {
    const files = execFileSync('git', ['ls-files', 'src/*.tsx', 'src/*.ts'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f !== '' && !f.includes('__tests__'));
    const hits = files.flatMap((f) =>
      (css(f).match(/\btext-\[[0-9](?:\.\d+)?px\]/g) ?? []).map((m) => `${f}: ${m}`),
    );
    expect(hits).toEqual([]);
  });
});

describe('TruncateStart 样式契约', () => {
  const SRC = css('src/design/TruncateStart.css');

  it('单行、溢出省略,方向 rtl 使截断与省略号落在开头;文本仍左对齐', () => {
    const body = ruleBody(SRC, '.wm-truncate-start');
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(body).toMatch(/direction:\s*rtl/);
    expect(body).toMatch(/text-align:\s*left/);
    expect(body).toMatch(/min-width:\s*0/);
  });

  it('内层按 ltr 隔离:路径开头的 / 等中性标点不被 rtl 挪到末尾', () => {
    const body = ruleBody(SRC, '.wm-truncate-start > [dir="ltr"]');
    expect(body).toMatch(/unicode-bidi:\s*isolate/);
  });
});

describe('EmptyState 样式契约', () => {
  const SRC = css('src/design/EmptyState.css');

  it('占满可用空间并居中,弱化正文色、无边框', () => {
    const body = ruleBody(SRC, '.wm-empty-state');
    expect(body).toMatch(/flex:\s*1 1 auto/);
    expect(body).toMatch(/align-items:\s*center/);
    expect(body).toMatch(/justify-content:\s*center/);
    expect(body).toMatch(/text-align:\s*center/);
    expect(body).toMatch(/color:\s*var\(--md-on-surface-variant\)/);
    expect(body).not.toMatch(/border/);
  });
});

describe('Tabs 样式契约(与设置页导航同一选中样式)', () => {
  const SRC = css('src/design/Tabs.css');

  it('选中项:左侧 2px primary 竖条 + surface-container-high 底(同设置页 border-accent bg-hover),不再是填充描边药丸', () => {
    const base = ruleBody(SRC, '.wm-tab-button');
    expect(base).toMatch(/border-left:\s*2px solid transparent/);
    expect(base).not.toMatch(/border-radius:\s*var\(--wm-radius-xl\)/);
    const active = ruleBody(SRC, '.wm-tab-button[data-active="true"]');
    expect(active).toMatch(/border-left-color:\s*var\(--md-primary\)/);
    expect(active).toMatch(/background-color:\s*var\(--md-surface-container-high\)/);
    expect(active).not.toMatch(/secondary-container/);
  });
});

// design CSS 必须在 Tailwind 的 components 层里:Tailwind v4 的 utility 在 `@layer utilities`,不在任何 layer 里的
// 样式(unlayered)无论选择器多弱都压过所有 layer —— 调用方传给 design 组件的 className(如 `@max-md:hidden`、
// `w-24`、`overflow-x-auto`)会被组件基类静默覆盖。层顺序 theme < base < components < utilities。
describe('design CSS 层级', () => {
  const TAILWIND = css('src/styles/tailwind.css');
  const INDEX = css('src/design/index.css');
  const designFiles = execFileSync('git', ['ls-files', 'src/design/*.css', 'src/design/*.tsx'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f !== '');

  it('tailwind.css 以 layer(components) 引入 design/index.css,且在 tailwindcss 之后', () => {
    const lines = TAILWIND.split('\n').map((l) => l.trim());
    const tw = lines.findIndex((l) => /^@import\s+["']tailwindcss["']/.test(l));
    const design = lines.findIndex((l) => /^@import\s+["']\.\.\/design\/index\.css["']/.test(l));
    expect(tw).toBeGreaterThanOrEqual(0);
    expect(design).toBeGreaterThan(tw);
    expect(lines[design]).toMatch(/layer\(components\)\s*;$/);
  });

  it('index.css 汇总全部 design 组件 CSS(无遗漏 → 无 unlayered 漏网)', () => {
    const imported = Array.from(INDEX.matchAll(/@import\s+['"]\.\/([\w-]+\.css)['"]/g), (m) => m[1]).sort();
    const all = designFiles
      .filter((f) => f.endsWith('.css') && !f.endsWith('/index.css'))
      .map((f) => f.slice('src/design/'.length))
      .sort();
    expect(imported).toEqual(all);
  });

  // design CSS 进 Tailwind 管线后由 lightningcss 按目标浏览器补前缀:源码同时写 `backdrop-filter` 与
  // `-webkit-backdrop-filter` 时,产物只剩带前缀那条 —— Chromium(Electron)不认,遮罩模糊整个丢失。
  it('design CSS 不手写 -webkit- 前缀属性(前缀交给构建按目标补)', () => {
    const hits = designFiles
      .filter((f) => f.endsWith('.css'))
      .flatMap((f) => (css(f).match(/^\s*-webkit-[a-z-]+\s*:/gm) ?? []).map((m) => `${f}: ${m.trim()}`));
    expect(hits).toEqual([]);
  });

  it('design 组件不在 TS 里直接 import 自身 CSS(否则打出一份 unlayered 副本,仍压过 utilities)', () => {
    const hits = designFiles
      .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
      .filter((f) => /^\s*import\s+['"][^'"]+\.css['"]/m.test(css(f)));
    expect(hits).toEqual([]);
  });
});

// 非 design 的原生 <button> / <a href> / 可 Tab 到的自定义控件(tabindex≥0)/ <summary>(状态栏 / 插件市场等行内文本按钮、
// 链接,注释说明为何不用 design)键盘焦点环与 design 控件同为
// focus-ring 蓝(VSCode focusBorder),不落回系统强调色(Chromium outline: auto)。规则放 base 层:design(components)
// 与调用方 utility(focus-visible:outline-*)仍可覆盖。
describe('原生按钮键盘焦点环', () => {
  const THEME = css('src/styles/theme.css');

  // 选择器包一层 :where() 零特异性:design 组件(components 层)、调用方 utility(FileRow 的 focus-visible:outline-*)、
  // dockview.css(未分层)都能覆盖;不含 contenteditable(CodeMirror / ProseMirror 内容区不画轮廓,编辑器聚焦无边框)。
  const BASE_FOCUS_SELECTOR = ':where(button, a[href], [tabindex]:not([tabindex="-1"]), summary):focus-visible';

  it('theme.css 的 @layer base 给原生按钮 / 链接 / 可 Tab 到的自定义控件 / summary 的 focus-visible 1px focus-ring 实线轮廓', () => {
    const base = THEME.match(/@layer base\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const body = ruleBody(base, BASE_FOCUS_SELECTOR);
    expect(body).toMatch(/outline:\s*1px solid var\(--md-focus-ring\)/);
    expect(base).not.toMatch(/contenteditable/);
  });

  it('原生按钮不用 outline-none 去掉焦点环而不补 focus-visible 轮廓', () => {
    const files = execFileSync('git', ['ls-files', 'src/*.tsx'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f !== '' && !f.startsWith('src/design/') && !f.includes('__tests__'));
    const hits = files.flatMap((f) =>
      Array.from(css(f).matchAll(/<button\b[^>]*?className="([^"]*)"/gs), (m) => m[1] ?? '')
        .filter((cls) => /\boutline-none\b/.test(cls) && !/focus-visible:outline/.test(cls))
        .map((cls) => `${f}: ${cls}`),
    );
    expect(hits).toEqual([]);
  });
});
