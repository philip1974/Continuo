// @vitest-environment jsdom
// 公式渲染:真实 KaTeX(懒加载)+ 真实 Crepe。见同目录 README.md。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { configureMarkdownStyle } from '../../panels/Editor/milkdown-markdown-style';
import { configureMarkdownMath } from '../../panels/Editor/milkdown-math';
import {
  KATEX_OPTIONS,
  loadKatex,
  renderMathHtml,
  renderMathInto,
  renderMathPreview,
  resetKatexForTest,
} from '../../panels/Editor/katex-render';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const editors: Crepe[] = [];

async function open(markdown: string, readonly = false): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({ root, defaultValue: markdown, features: { [Crepe.Feature.ImageBlock]: false } });
  configureMarkdownStyle(crepe, markdown);
  configureMarkdownMath(crepe);
  if (readonly) crepe.setReadonly(true);
  editors.push(crepe);
  await crepe.create();
  return root;
}

/** 等懒加载与分帧补渲完成。 */
async function settle(root: HTMLElement): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
    if (root.querySelector('.continuo-math-pending') === null && root.querySelector('.milkdown-code-block .preview-loading') === null) return;
  }
}

beforeEach(() => {
  resetKatexForTest();
});

afterEach(async () => {
  for (const crepe of editors.splice(0)) await crepe.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('编辑 / 预览模式渲染公式', () => {
  it('行内公式:katex 加载前显示原文,加载后渲染成 KaTeX', async () => {
    const root = await open('Energy $x_1 + y_2$ here.\n');
    const span = root.querySelector<HTMLElement>('[data-type="math_inline"]')!;
    expect(span.classList.contains('continuo-math-pending')).toBe(true);
    expect(span.textContent).toBe('x_1 + y_2');
    await settle(root);
    expect(span.querySelector('.katex')).not.toBeNull();
    expect(span.querySelector('.katex-display')).toBeNull();
    // MathML 副本供读屏
    expect(span.querySelector('math annotation')?.textContent).toBe('x_1 + y_2');
  });

  it('`$$…$$` 行内写法按块级显示;`$$` 公式块在代码块预览里渲染', async () => {
    const root = await open('Display $$E = mc^2$$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$\n', true);
    await settle(root);
    expect(root.querySelector('[data-type="math_inline"] .katex-display')).not.toBeNull();
    const block = root.querySelector('.milkdown-code-block .continuo-math-block');
    expect(block?.querySelector('.katex-display')).not.toBeNull();
  });

  it('```math 围栏同样显示公式预览(同 VSCode enableFencedBlocks)', async () => {
    const root = await open('```math\na^2\n```\n', true);
    await settle(root);
    expect(root.querySelector('.milkdown-code-block .continuo-math-block .katex')).not.toBeNull();
  });

  it('错误公式:就地显示错误色原文与错误信息,不影响其余公式', async () => {
    const root = await open('bad $\\frac{1}{2$ and good $y$\n');
    await settle(root);
    const err = root.querySelector<HTMLElement>('.katex-error')!;
    expect(err.textContent).toBe('\\frac{1}{2');
    expect(err.getAttribute('style')).toContain('var(--md-error)');
    expect(err.getAttribute('title')).toMatch(/ParseError/);
    expect(root.querySelectorAll('[data-type="math_inline"] .katex').length).toBe(1);
  });
});

describe('KaTeX 选项与安全', () => {
  it('trust 关闭、错误不抛;不往控制台刷 strict 警告', () => {
    expect(KATEX_OPTIONS).toMatchObject({ throwOnError: false, trust: false, strict: 'ignore' });
  });

  it('\\href / \\url / \\includegraphics / \\htmlClass 不生成链接 / 图片 / 自定义 class', async () => {
    await loadKatex();
    const el = document.createElement('div');
    el.innerHTML = renderMathHtml(
      '\\href{javascript:alert(1)}{x} \\url{https://e.com} \\includegraphics{a.png} \\htmlClass{evil}{y}',
      false,
    )!;
    expect(el.querySelector('a')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.evil')).toBeNull();
  });

  it('普通公式不内联颜色(用 currentColor 随正文 / 主题)', async () => {
    await loadKatex();
    expect(renderMathHtml('x^2 + \\alpha', false)).not.toMatch(/color\s*:/);
  });
});

describe('懒加载与大量公式', () => {
  it('katex 只经动态 import 加载(MilkdownEditor chunk 不含 katex)', () => {
    const src = readFileSync(join(process.cwd(), 'src/panels/Editor/katex-render.ts'), 'utf-8');
    expect(src).toMatch(/import\('katex'\)/);
    // 样式表随 Crepe 主题(latex.css @import katex.min.css),不重复引入
    expect(readFileSync(join(process.cwd(), 'node_modules/@milkdown/crepe/lib/theme/common/latex.css'), 'utf-8')).toMatch(
      /@import 'katex\/dist\/katex\.min\.css'/,
    );
    expect(src).not.toMatch(/^import .* from 'katex/m);
    const mathSrc = readFileSync(join(process.cwd(), 'src/panels/Editor/milkdown-math.ts'), 'utf-8');
    expect(mathSrc).not.toMatch(/from 'katex'/);
  });

  it('加载前 renderMathHtml 为 null;代码块预览先返回 undefined(显示加载中)再 applyPreview', async () => {
    expect(renderMathHtml('x', false)).toBeNull();
    const apply = vi.fn();
    expect(renderMathPreview('a^2', apply)).toBeUndefined();
    await loadKatex();
    await new Promise((r) => setTimeout(r, 0));
    expect(apply).toHaveBeenCalledWith(expect.stringContaining('continuo-math-block'));
    expect(renderMathPreview('', apply)).toBeNull();
    expect(renderMathPreview('a^2', apply)).toMatch(/katex/);
  });

  it('一帧同步渲染有时间预算:超出的先显示原文,之后分帧补渲完', async () => {
    await loadKatex();
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (t += 5));
    const els = Array.from({ length: 40 }, (_, i) => {
      const el = document.createElement('span');
      document.body.appendChild(el);
      renderMathInto(el, `x_{${i}}`, false);
      return el;
    });
    const pending = els.filter((el) => el.classList.contains('continuo-math-pending')).length;
    expect(pending).toBeGreaterThan(30);
    for (let i = 0; i < 100 && els.some((el) => el.classList.contains('continuo-math-pending')); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(els.every((el) => el.querySelector('.katex') !== null)).toBe(true);
  });

  it('同一公式只渲染一次(缓存)', async () => {
    await loadKatex();
    expect(renderMathHtml('\\sum_i x_i', true)).toBe(renderMathHtml('\\sum_i x_i', true));
  });

  // 200 段 × 10 个单字母公式(10 种):挂载 2000 个公式节点的成本不变;用短公式是因为 jsdom 里每个公式的 KaTeX 排版 + innerHTML
  // 写入要几毫秒,补渲按 12ms 一帧分帧,2000 个 `x_{i}^{j}` 单独跑就要 8 秒、全量并发负载下超过 30 秒(分帧补渲由上一个用例覆盖)。
  it('2000 个公式的文档:挂载不卡(公式先显示原文,随后全部渲染)', async () => {
    const md = Array.from({ length: 200 }, () => Array.from({ length: 10 }, (_, j) => `$${'abcdefghij'[j]}$`).join(' ')).join('\n\n');
    const t0 = performance.now();
    const root = await open(`${md}\n`);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(root.querySelectorAll('[data-type="math_inline"]').length).toBe(2000);
    // 等补渲完成(settle 只等约 2 秒;负载下分帧补渲可能更久,这里按截止时间等)
    const deadline = performance.now() + 45_000;
    while (root.querySelector('.continuo-math-pending') !== null && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(root.querySelectorAll('.continuo-math-pending').length).toBe(0);
  }, 60_000);
});

describe('编辑器文案', () => {
  it('斜杠菜单「公式」与浮动工具条「行内公式」取自 catalog(三种语言)', () => {
    const src = readFileSync(join(process.cwd(), 'src/panels/Editor/MilkdownEditor.tsx'), 'utf-8');
    expect(src).toMatch(/math: item\('panels\.editor\.md\.slash\.math'\)/);
    expect(src).toMatch(/latexLabel: t\('panels\.editor\.md\.toolbar\.math'\)/);
    for (const cat of [en, zh, ko] as Record<string, string>[]) {
      expect(cat['panels.editor.md.slash.math']).toBeTruthy();
      expect(cat['panels.editor.md.toolbar.math']).toBeTruthy();
    }
  });
});
