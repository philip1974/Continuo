// 搜索结果右键菜单(VSCode MenuId.SearchContext,BDD: src/__tests__/list-context-menus/):右键 / Shift+F10 打开、
// 复制路径、移除结果、Esc 焦点回到结果树。走真实 main 搜索 worker。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';

const QUERY = /^(搜索|Search|검색)$/;
const STATUS = '[data-testid=search-panel] [role=status]';
const DISMISS = /^(移除|Dismiss|해제)$/;
const COPY_PATH = /^(复制路径|Copy Path|경로 복사)$/;
const COPY = /^(复制|Copy|복사)$/;
const COPY_ALL = /^(全部复制|Copy All|모두 복사)$/;
const resultsTree = (window: Page) => window.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ });

test.beforeEach(async ({ window }) => {
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
});

async function searchFor(window: Page, text: string) {
  await waitForTestHooks(window);
  await window.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = window.getByRole('textbox', { name: QUERY });
  await expect(input).toBeFocused({ timeout: 10_000 });
  await input.fill(text);
}

test('文件行右键 → 复制路径写入剪贴板;匹配行右键 → 移除该结果、计数更新', async ({ window, electronApp, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'src', 'c.ts'), 'needle1\nneedle2\n');
  await searchFor(window, 'needle');
  await expect(window.locator(STATUS)).toHaveText(/(2 results in 1 file|1 个文件中有 2 个结果|파일 1개에서 결과 2개)/, { timeout: 10_000 });
  const tree = resultsTree(window);
  await expect(tree.getByRole('treeitem')).toHaveCount(3);

  await tree.getByRole('treeitem').first().click({ button: 'right' });
  const menu = window.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: COPY_PATH })).toBeVisible();
  await menu.getByRole('menuitem', { name: COPY_PATH }).click();
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
    .toBe(path.join(workspaceRoot, 'src', 'c.ts'));

  await tree.getByRole('treeitem').nth(1).click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: COPY_PATH })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: DISMISS }).click();
  await expect(menu).toHaveCount(0);
  await expect(tree.getByRole('treeitem')).toHaveCount(2);
  await expect(window.locator(STATUS)).toHaveText(/(1 result in 1 file|1 个文件中有 1 个结果|파일 1개에서 결과 1개)/);
  await expect(tree).toBeFocused();
});

test('结果树聚焦时 Shift+F10 → 活动行菜单(定位在该行);Esc → 焦点回到结果树', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'src', 'c.ts'), 'needle1\nneedle2\n');
  await searchFor(window, 'needle');
  const tree = resultsTree(window);
  await expect(tree.getByRole('treeitem')).toHaveCount(3, { timeout: 10_000 });
  await window.keyboard.press('ArrowDown'); // 查询框 ↓ → 结果树,活动行 = 第一行
  await expect(tree).toBeFocused();
  await window.keyboard.press('ArrowDown'); // 第一个匹配

  await window.keyboard.press('Shift+F10');
  const menu = window.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText([DISMISS, COPY, COPY_ALL]);
  const rowBox = (await tree.getByRole('treeitem').nth(1).boundingBox())!;
  const menuBox = (await menu.boundingBox())!;
  expect(Math.abs(menuBox.y - (rowBox.y + rowBox.height))).toBeLessThan(40);

  await window.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(tree).toBeFocused();
});
