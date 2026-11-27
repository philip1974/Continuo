// 界面外框不可选中文字(BDD: src/__tests__/chrome-select-none/):真实右键资源管理器标题 / 大纲标题后页面没有选区;
// 编辑器 tab 计算样式 user-select: none。
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';

const selectionText = (window: Page) => window.evaluate(() => document.getSelection()?.toString() ?? '');

test('右键侧栏标题 / 大纲标题不选中文字;编辑器 tab 不可选', async ({ window, workspaceRoot }) => {
  const readme = path.join(workspaceRoot, 'README.md');
  await expect(window.locator(`[role=treeitem][title="${readme}"]`)).toBeVisible({ timeout: 10_000 });
  const title = window.getByRole('main').locator(`span[title="${workspaceRoot}"]`).first();
  await title.click({ button: 'right' });
  await window.keyboard.press('Escape');
  expect(await selectionText(window)).toBe('');
  await title.dblclick();
  expect(await selectionText(window)).toBe('');

  const outline = window.getByTestId('outline-view').getByRole('button').first();
  await outline.click({ button: 'right' });
  await window.keyboard.press('Escape');
  expect(await selectionText(window)).toBe('');

  await openTreeItem(window, 'README.md');
  const tab = window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab').first();
  await expect(tab).toBeVisible();
  expect(await tab.evaluate((el) => getComputedStyle(el).userSelect)).toBe('none');
});
