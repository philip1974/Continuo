// 资源管理器「在侧边打开」(VSCode explorer.openToSide / ⌥ 单击 → SIDE_GROUP;BDD: src/__tests__/explorer-open-to-side/):
// 右键「在侧边打开」→ 在活动编辑器组右侧拆出新组常驻打开并获焦;⌥ 单击 → 侧边组预览打开、焦点留在树,再 ⌥ 单击仍落在同一侧边组。
// 真实鼠标右键 / ⌥ 单击。
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS } from './helpers/editor';
import { expandTreeItem, openTreeItem } from './helpers/explorer';

const OPEN_TO_SIDE = /^(在侧边打开|Open to the Side|측면에서 열기)/;
const rowOf = (window: Page, p: string) => window.locator(`[role=treeitem][title="${p}"]`);
const groups = (window: Page) => window.locator('[data-editor-panel-root]');
const tabNames = (window: Page, i: number) =>
  groups(window)
    .nth(i)
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab')
    .evaluateAll((els) =>
      els.map((el) => `${(el.getAttribute('title') ?? '').split(/[\\/]/).pop()}${el.querySelector('[data-preview]') ? ' (preview)' : ''}`),
    );
/** 焦点所在编辑器组的 DOM 下标(不在编辑器组 → -1)。 */
const focusedGroupIndex = (window: Page) =>
  window.evaluate(() => {
    const roots = [...document.querySelectorAll('[data-editor-panel-root]')];
    const root = document.activeElement?.closest('[data-editor-panel-root]');
    return root ? roots.indexOf(root) : -1;
  });
/** 编辑器组根元素的左边缘(按屏幕从左到右排序用)。 */
const groupLefts = (window: Page) =>
  groups(window).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));

test.beforeEach(async ({ window }) => {
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
});

test('右键文件「在侧边打开」→ 活动组右侧拆出新组,常驻打开并获焦', async ({ window, workspaceRoot }) => {
  const readme = path.join(workspaceRoot, 'README.md');
  const a = path.join(workspaceRoot, 'src/a.ts');
  await expect(rowOf(window, readme)).toBeVisible({ timeout: 10_000 });
  await openTreeItem(window, 'README.md');
  await expect.poll(() => tabNames(window, 0)).toEqual(['README.md']);
  await expandTreeItem(window, 'src');

  await rowOf(window, a).click({ button: 'right' });
  const item = window.getByRole('menuitem', { name: OPEN_TO_SIDE });
  // 文件菜单首项
  await expect(window.getByRole('menuitem').first()).toHaveText(OPEN_TO_SIDE);
  await item.click();

  await expect(groups(window)).toHaveCount(2, { timeout: 10_000 });
  const lefts = await groupLefts(window);
  const right = lefts[0]! < lefts[1]! ? 1 : 0;
  await expect.poll(() => tabNames(window, right)).toEqual(['a.ts']);
  await expect.poll(() => tabNames(window, 1 - right)).toEqual(['README.md']);
  await expect.poll(() => focusedGroupIndex(window)).toBe(right);
});

test('⌥ 单击文件 → 侧边组预览打开、焦点留在资源管理器;再 ⌥ 单击别的文件仍落在同一侧边组', async ({
  window,
  workspaceRoot,
}) => {
  const readme = path.join(workspaceRoot, 'README.md');
  const a = path.join(workspaceRoot, 'src/a.ts');
  const b = path.join(workspaceRoot, 'src/b.ts');
  await expect(rowOf(window, readme)).toBeVisible({ timeout: 10_000 });
  await openTreeItem(window, 'README.md');
  await expect.poll(() => tabNames(window, 0)).toEqual(['README.md']);
  await expandTreeItem(window, 'src');

  await rowOf(window, a).click({ modifiers: ['Alt'] });
  await expect(groups(window)).toHaveCount(2, { timeout: 10_000 });
  const lefts = await groupLefts(window);
  const right = lefts[0]! < lefts[1]! ? 1 : 0;
  await expect.poll(() => tabNames(window, right)).toEqual(['a.ts (preview)']);
  await expect.poll(() => tabNames(window, 1 - right)).toEqual(['README.md']);
  await expect.poll(() => window.evaluate(() => !!document.activeElement?.closest('[role=tree]'))).toBe(true);

  await rowOf(window, b).click({ modifiers: ['Alt'] });
  await expect.poll(() => tabNames(window, right)).toEqual(['b.ts (preview)']);
  await expect(groups(window)).toHaveCount(2);
  await expect.poll(() => window.evaluate(() => !!document.activeElement?.closest('[role=tree]'))).toBe(true);
});
