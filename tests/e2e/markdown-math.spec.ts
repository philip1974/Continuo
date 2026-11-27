// Markdown 数学公式(真实 KaTeX 懒加载 + Crepe):预览 / 编辑模式渲染,编辑非公式内容后公式字节不变,
// 点击行内公式在浮层里改,错误公式就地提示,深 / 浅主题下颜色跟随 token,字体走本地文件。
// 见 src/__tests__/markdown-math/。
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_EDIT, EDITOR_MODE_PREVIEW, editorModeButton, openWorkspaceFile } from './helpers/editor';

const PM = 'main .milkdown .ProseMirror';
const SWITCH_ANYWAY = /^(仍然切换|Switch anyway|그래도 전환)$/;

const DOC = [
  '# Math',
  '',
  'Energy $x_1 + y_2 = z_{max}$ here, thin $a\\,b$ and set $\\{x\\}$.',
  '',
  '$$',
  '\\int_0^1 x\\,dx',
  '$$',
  '',
  'Display $$E = mc^2$$ inline; prices $5 and $10 stay text.',
  '',
  'Broken $\\frac{1}{2$ formula.',
  '',
  'Tail paragraph.',
  '',
].join('\n');

async function open(window: Page, workspaceRoot: string, name: string, content: string): Promise<string> {
  const file = path.join(workspaceRoot, name);
  writeFileSync(file, content);
  await openWorkspaceFile(window, [name]);
  return file;
}

/** 解析 CSS 颜色值(含 var())为 computed rgb。 */
async function resolveColor(window: Page, cssColor: string): Promise<string> {
  return window.evaluate((c) => {
    const probe = document.createElement('span');
    probe.style.color = c;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, cssColor);
}

test('Preview:行内 / 块公式渲染成 KaTeX,错误公式就地提示,金额保持文字', async ({ window, workspaceRoot }) => {
  // 渲染链路不触发 CSP 拦截(不需要 unsafe-eval、字体 / 样式都走本地)
  const cspViolations: string[] = [];
  window.on('console', (msg) => {
    if (/Content Security Policy|unsafe-eval/i.test(msg.text())) cspViolations.push(msg.text());
  });
  await open(window, workspaceRoot, 'math.md', DOC);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();

  const inline = window.locator(`${PM} [data-type="math_inline"]`);
  await expect(inline).toHaveCount(5, { timeout: 15_000 });
  await expect(inline.first().locator('.katex')).toBeVisible({ timeout: 15_000 });
  await expect(window.locator(`${PM} .continuo-math-pending`)).toHaveCount(0, { timeout: 15_000 });
  // `$$…$$` 行内写法与公式块按块级显示
  await expect(window.locator(`${PM} [data-type="math_inline"] .katex-display`)).toHaveCount(1);
  const block = window.locator('main .milkdown .milkdown-code-block .continuo-math-block .katex-display');
  await expect(block).toBeVisible({ timeout: 15_000 });
  // 只读预览只显示公式,不显示 LaTeX 源码
  await expect(window.locator('main .milkdown .cm-content').filter({ hasText: '\\int_0^1' })).toBeHidden();
  // 错误公式:错误色原文 + 错误信息
  const err = window.locator(`${PM} .katex-error`);
  await expect(err).toHaveText('\\frac{1}{2');
  await expect(err).toHaveAttribute('title', /ParseError/);
  await expect(window.locator(PM)).toContainText('prices $5 and $10 stay text.');
  expect(cspViolations).toEqual([]);
});

test('Edit:含公式的文档直接进编辑模式;改非公式内容保存,只变那一行,公式字节不变', async ({
  window,
  workspaceRoot,
}) => {
  const file = await open(window, workspaceRoot, 'edit.md', DOC);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  // 不再锁源码模式:没有「仍然切换」确认框
  await expect(window.locator(PM)).toHaveAttribute('contenteditable', 'true', { timeout: 10_000 });
  await expect(window.getByRole('button', { name: SWITCH_ANYWAY })).toHaveCount(0);
  await expect(window.locator(`${PM} [data-type="math_inline"] .katex`).first()).toBeVisible({ timeout: 15_000 });

  await window.locator(PM).getByText('Tail paragraph.').click();
  await window.keyboard.press('End');
  await window.keyboard.type(' More.');
  await window.keyboard.press('ControlOrMeta+KeyS');
  await expect(async () => {
    const after = (await readFile(file, 'utf8')).split('\n');
    const before = DOC.split('\n');
    const changed = after.flatMap((line, i) => (line === before[i] ? [] : [`${i + 1}: ${line}`]));
    expect(changed).toEqual(['13: Tail paragraph. More.']);
    expect(after.length).toBe(before.length);
  }).toPass({ timeout: 5_000 });
});

test('Edit:点击行内公式在浮层里改原文,回车写回(规范写法)', async ({ window, workspaceRoot }) => {
  const file = await open(window, workspaceRoot, 'click.md', 'Value $x^2$ here.\n');
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const math = window.locator(`${PM} [data-type="math_inline"]`);
  await expect(math.locator('.katex')).toBeVisible({ timeout: 15_000 });
  await math.click();
  const tooltip = window.locator('.milkdown-latex-inline-edit[data-show="true"]');
  await expect(tooltip).toBeVisible({ timeout: 5_000 });
  const input = tooltip.locator('.ProseMirror');
  await input.click();
  await window.keyboard.press('End');
  await window.keyboard.type('+1');
  await window.keyboard.press('Enter');
  await expect(math).toHaveAttribute('data-value', 'x^2+1');
  await window.keyboard.press('ControlOrMeta+KeyS');
  await expect(async () => {
    expect(await readFile(file, 'utf8')).toBe('Value $x^2+1$ here.\n');
  }).toPass({ timeout: 5_000 });
});

test('深 / 浅主题:公式颜色随正文,错误色取 --md-error;字体从本地加载', async ({ window, workspaceRoot }) => {
  await open(window, workspaceRoot, 'theme.md', DOC);
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
  const formula = window.locator(`${PM} [data-type="math_inline"] .katex`).first();
  await expect(formula).toBeVisible({ timeout: 15_000 });
  const err = window.locator(`${PM} .katex-error`);

  const check = async (): Promise<string> => {
    const color = await formula.evaluate((el) => getComputedStyle(el).color);
    const text = await window.locator(`${PM} p`).first().evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe(text);
    expect(await err.evaluate((el) => getComputedStyle(el).color)).toBe(await resolveColor(window, 'var(--md-error)'));
    return color;
  };
  await expect(window.locator('html')).toHaveClass(/dark/);
  const dark = await check();
  await window.evaluate(() => {
    globalThis.__continuoTest!.setSettingValue('general.theme', 'light');
  });
  await expect(window.locator('html')).not.toHaveClass(/dark/, { timeout: 5_000 });
  const light = await check();
  expect(light).not.toBe(dark);

  // KaTeX 字体:打包进来的本地文件(CSP font-src 'self'),已加载
  await expect
    .poll(() =>
      window.evaluate(() =>
        [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'KaTeX_Main' && f.status === 'loaded'),
      ),
    )
    .toBe(true);
  // @font-face 的来源是随应用打包的本地文件(file:// 资源不进 Resource Timing,改查样式规则)
  const fontSrcs = await window.evaluate(() => {
    const out: string[] = [];
    for (const sheet of [...document.styleSheets]) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of [...rules]) {
        if (rule instanceof CSSFontFaceRule && rule.style.getPropertyValue('font-family').includes('KaTeX_Main')) {
          out.push(`${sheet.href ?? ''} ${rule.style.getPropertyValue('src')}`);
        }
      }
    }
    return out;
  });
  expect(fontSrcs.length).toBeGreaterThan(0);
  for (const src of fontSrcs) {
    expect(src).toMatch(/KaTeX_Main-[\w-]+\.woff2/);
    expect(src).not.toMatch(/https?:\/\//);
  }
});
