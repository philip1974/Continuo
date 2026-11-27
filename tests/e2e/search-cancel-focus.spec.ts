// 取消搜索 /「重新搜索」/「在所有文件中重新搜索」后焦点回到查询框(VSCode SearchView.cancelSearch(focus = true) →
// searchWidget.focus();triggerQueryChange({ preserveFocus: false })):被点的按钮随状态卸载,焦点不能掉到 body。
// BDD: src/__tests__/workspace-search/ 8a。慢搜索用灾难性回溯的正则 `(a+)+$` 造(取消 = 终止 worker)。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';

const SLOW_LINE = `${'a'.repeat(34)}b\n`;

async function setup(window: Page, workspaceRoot: string) {
  for (let i = 0; i < 3; i++) writeFileSync(path.join(workspaceRoot, `zz-slow${i}.txt`), SLOW_LINE);
  await waitForTestHooks(window);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('general.language', 'en'));
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  const panel = window.getByTestId('search-panel');
  const input = panel.getByRole('textbox', { name: 'Search', exact: true });
  await expect(input).toBeFocused({ timeout: 10_000 });
  await panel.getByRole('button', { name: 'Use Regular Expression' }).click();
  return { panel, input };
}

test('「取消搜索」按钮与结果树 Esc:取消后焦点回查询框', async ({ window, workspaceRoot }) => {
  const { panel, input } = await setup(window, workspaceRoot);
  await input.fill('(a+)+$');
  const cancel = panel.getByRole('button', { name: 'Cancel Search' });
  await expect(cancel).toBeVisible({ timeout: 10_000 });
  await cancel.click();
  await expect(cancel).toHaveCount(0);
  await expect(input).toBeFocused();
  expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 6]);

  // 结果树上 Esc(搜索仍在进行)
  await input.press('Enter');
  await expect(cancel).toBeVisible({ timeout: 10_000 });
  const tree = panel.getByRole('tree');
  await tree.focus();
  await expect(tree).toBeFocused();
  await window.keyboard.press('Escape');
  await expect(panel.getByRole('status')).toContainText(/Search was canceled/, { timeout: 5_000 });
  await expect(input).toBeFocused();
});

test('「重新搜索」与「在所有文件中重新搜索」:点后焦点回查询框', async ({ window, workspaceRoot }) => {
  const { panel, input } = await setup(window, workspaceRoot);
  await panel.getByRole('button', { name: 'Toggle Search Details' }).click();
  await panel.getByRole('textbox', { name: 'files to include' }).fill('zz-*');
  await input.fill('(a+)+$');
  const cancel = panel.getByRole('button', { name: 'Cancel Search' });
  await expect(cancel).toBeVisible({ timeout: 10_000 });
  await cancel.click();
  const again = panel.getByRole('button', { name: 'Search again', exact: true });
  await expect(again).toBeVisible();
  await again.click();
  await expect(again).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(cancel).toBeVisible({ timeout: 10_000 });
  await cancel.click();

  await panel.getByRole('button', { name: 'Use Regular Expression' }).click();
  await input.fill('nothing-matches-here');
  const all = panel.getByRole('button', { name: 'Search again in all files' });
  await expect(all).toBeVisible({ timeout: 10_000 });
  await all.click();
  await expect(panel.getByRole('textbox', { name: 'files to include' })).toHaveValue('');
  await expect(input).toBeFocused();
});
