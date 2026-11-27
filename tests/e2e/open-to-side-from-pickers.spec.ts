// Quick Open ⌘Enter / ⌥Enter 与搜索结果 ⌃Enter「在侧边打开」(VSCode SIDE_GROUP;BDD: src/__tests__/open-to-side-from-pickers/):
// 活动编辑器组右侧拆出新组常驻打开并获焦;`文件:行` 同样跳行。真实键盘。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS } from './helpers/editor';
import { openQuickOpen, quickOpenInput } from './helpers/palette';
import { waitForTestHooks } from './helpers/app-ready';
import { cmSelection } from './helpers/codemirror';

const QUERY = /^(搜索|Search|검색)$/;
const groups = (window: Page) => window.locator('[data-editor-panel-root]');
const tabNames = (window: Page, i: number) =>
  groups(window)
    .nth(i)
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab')
    .evaluateAll((els) => els.map((el) => (el.getAttribute('title') ?? '').split(/[\\/]/).pop()));
const groupLefts = (window: Page) =>
  groups(window).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
const focusedGroupIndex = (window: Page) =>
  window.evaluate(() => {
    const roots = [...document.querySelectorAll('[data-editor-panel-root]')];
    const root = document.activeElement?.closest('[data-editor-panel-root]');
    return root ? roots.indexOf(root) : -1;
  });
/** 第 i 个编辑器组里编辑器的光标行。 */
const cursorLine = async (window: Page, i: number) =>
  (await cmSelection(groups(window).nth(i).locator('.cm-content'))).headLine;

test.beforeEach(async ({ window }) => {
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
});

async function openReadme(window: Page) {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(window.locator('.wm-modal-content')).toContainText('README.md', { timeout: 10_000 });
  await input.fill('README.md');
  await input.press('Enter');
  await expect.poll(() => tabNames(window, 0)).toEqual(['README.md']);
}

async function sideIndex(window: Page): Promise<number> {
  await expect(groups(window)).toHaveCount(2, { timeout: 10_000 });
  const lefts = await groupLefts(window);
  return lefts[0]! < lefts[1]! ? 1 : 0;
}

test('Quick Open ⌘Enter(Ctrl+Enter)→ 右侧拆出新组打开并获焦;`文件:行` 跳到该行', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'src', 'long.ts'), Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join('\n'));
  await openReadme(window);
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await input.fill('long.ts:20');
  await expect(window.locator('.wm-modal-content li').first()).toHaveAttribute('title', 'src/long.ts');
  await input.press('ControlOrMeta+Enter');
  const right = await sideIndex(window);
  await expect.poll(() => tabNames(window, right)).toEqual(['long.ts']);
  await expect.poll(() => tabNames(window, 1 - right)).toEqual(['README.md']);
  await expect.poll(() => focusedGroupIndex(window)).toBe(right);
  await expect.poll(() => cursorLine(window, right)).toBe(20);
});

test('Quick Open ⌥Enter(Alt+Enter)同样在侧边打开', async ({ window }) => {
  await openReadme(window);
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await input.fill('a.ts');
  await expect(window.locator('.wm-modal-content li').first()).toHaveAttribute('title', 'src/a.ts');
  await input.press('Alt+Enter');
  const right = await sideIndex(window);
  await expect.poll(() => tabNames(window, right)).toEqual(['a.ts']);
});

test('搜索结果匹配行 ⌃Enter(Ctrl+Enter)→ 侧边组打开并定位到命中', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'src', 'b.ts'), 'line1\nline2\nconst needle = 3;\n');
  await openReadme(window);
  await waitForTestHooks(window);
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = window.getByRole('textbox', { name: QUERY });
  await expect(input).toBeFocused({ timeout: 10_000 });
  await input.fill('needle');
  const tree = window.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ });
  await expect(tree.getByRole('treeitem')).toHaveCount(2, { timeout: 10_000 });
  await input.press('ArrowDown'); // 进入结果树(文件行)
  await window.keyboard.press('ArrowDown'); // 匹配行
  await window.keyboard.press('Control+Enter');
  const right = await sideIndex(window);
  await expect.poll(() => tabNames(window, right)).toEqual(['b.ts']);
  await expect.poll(() => tabNames(window, 1 - right)).toEqual(['README.md']);
  await expect.poll(() => cursorLine(window, right)).toBe(3);
});
