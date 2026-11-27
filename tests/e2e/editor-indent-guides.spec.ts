// 缩进参考线(editor.guides.indentation,默认开;当前块高亮):真实渲染的竖线落在每一级缩进列的左边缘,当前块那一条颜色不同;
// 大文件(10 万行 / 2 MB 单行 minified)滚动 / 移动光标 / 输入与关掉参考线时相比不明显变慢。
// BDD: src/__tests__/editor-indent-guides/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';
import { waitForTestHooks } from './helpers/app-ready';
import { compareSettingCost } from './helpers/editor-perf';

const NESTED = 'function f() {\n    if (x) {\n        return 1;\n    }\n    return 2;\n}\n';

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
  workspaceRoot: async ({}, use) => {
    const root = mkdtempSync(path.join(tmpdir(), 'ui157-ig-ws-'));
    writeFileSync(path.join(root, 'g.ts'), NESTED);
    // 10 万行(每 4 行一个缩进块)≈ 2.4 MB;2 MB 单行 minified
    const block = 'function f() {\n    if (x) {\n        return 1;\n    }\n';
    writeFileSync(path.join(root, 'big.ts'), block.repeat(25_000));
    writeFileSync(path.join(root, 'min.js'), `var a=${'[1,{"k":"v"},2],'.repeat(140_000)}0;\n`);
    await use(root);
    rmSync(root, { recursive: true, force: true });
  },
});

/** 第 n 行(1 起)各条参考线的屏幕 x 与颜色(::before 的多层背景:位置 = 行左 + 伪元素 left + 背景偏移)。 */
function guidesOfLine(window: Page, n: number): Promise<{ xs: number[]; colors: string[]; cols: number[] }> {
  return window.locator('.cm-content').first().evaluate((content, line) => {
    type View = { state: { doc: { line(n: number): { from: number } } }; coordsAtPos(pos: number): { left: number } | null };
    const view = (content as unknown as { cmTile: { root: { view: View } } }).cmTile.root.view;
    const el = content.querySelectorAll<HTMLElement>('.cm-line')[line - 1]!;
    const before = getComputedStyle(el, '::before');
    const left = el.getBoundingClientRect().left + parseFloat(before.left);
    const xs = before.backgroundPositionX.split(',').map((v) => left + parseFloat(v));
    // 每一层渐变 = 一条(或一段同色的多条)参考线:取其首个颜色
    const colors = before.backgroundImage
      .split('repeating-linear-gradient(')
      .slice(1)
      .map((layer) => /rgba?\([^)]*\)/.exec(layer)?.[0] ?? '');
    const from = view.state.doc.line(line).from;
    const cols = [0, 4].map((c) => view.coordsAtPos(from + c)!.left);
    return { xs, colors, cols };
  }, n);
}

const tokenColor = (window: Page, name: string) =>
  window.evaluate((n) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${n})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

test('竖线落在缩进列左边缘;光标所在块那一条用 active 色,其余用普通色;关掉设置即消失', async ({ window }) => {
  await openWorkspaceFile(window, ['g.ts']);
  await expect(window.locator('.cm-content').first()).toContainText('return 1');
  // 光标放到第 3 行(最内层块)
  await window.locator('.cm-line').nth(2).click();
  await expect(window.locator('.cm-line').nth(2)).toHaveClass(/cm-indent-markers/);
  await expect(window.locator('.cm-line').first()).not.toHaveClass(/cm-indent-markers/);

  const g = await guidesOfLine(window, 3);
  // 第 3 行缩 8 格(两级):竖线在第 0 列与第 4 列左边缘
  const xs = [...new Set(g.xs.map((x) => Math.round(x)))].sort((a, b) => a - b);
  expect(xs.length).toBeGreaterThanOrEqual(2);
  expect(Math.abs(xs[0]! - g.cols[0]!)).toBeLessThanOrEqual(1);
  expect(Math.abs(xs[xs.length - 1]! - g.cols[1]!)).toBeLessThanOrEqual(1);

  const normal = await tokenColor(window, '--md-indent-guide');
  const active = await tokenColor(window, '--md-indent-guide-active');
  expect(normal).not.toBe(active);
  expect(g.colors).toContain(active); // 当前块(第二级)
  expect(g.colors).toContain(normal); // 外层(第一级)
  // 光标移到第 5 行(函数体这一级)→ 第 3 行的第二级不再是 active
  await window.locator('.cm-line').nth(4).click();
  await expect.poll(async () => (await guidesOfLine(window, 3)).colors.filter((c) => c === active).length).toBe(1);

  await waitForTestHooks(window);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.guides.indentation', false));
  await expect(window.locator('.cm-indent-markers')).toHaveCount(0);
});

test('大文件:10 万行与 2 MB 单行 minified,参考线开 / 关耗时相近', async ({ window }) => {
  test.setTimeout(180_000);
  await compareSettingCost(window, 'big.ts', false, 'editor.guides.indentation', true, false);
  await compareSettingCost(window, 'min.js', true, 'editor.guides.indentation', true, false);
});
