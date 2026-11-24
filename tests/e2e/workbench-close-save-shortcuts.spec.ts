// BDD: workbench-editor-commands —— ⌘W 关当前编辑器 tab(窗口仍在)、焦点在 Explorer 时 ⌘S 仍保存活动文件。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS } from './helpers/editor';

test('编辑器里 mod+W → 只关当前文件 tab,窗口仍在', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await window.locator('text=b.ts').first().click();
  const tabs = window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab');
  await expect(tabs).toHaveCount(2, { timeout: 10_000 });

  const cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.press('ControlOrMeta+w');

  await expect(tabs).toHaveCount(1, { timeout: 5_000 });
  await expect(tabs.first()).toContainText('a.ts');
  expect(window.isClosed()).toBe(false);
  // 窗口仍可交互(没有走关窗流程)
  await expect(window.locator('.cm-content').first()).toBeVisible();
});

test('焦点在 Explorer 时 mod+S → 保存活动文件', async ({ window, workspaceRoot }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type('\n// saved-from-explorer');

  // 焦点移到 Explorer 树(点 src 文件夹行:只折叠,不打开文件、不把焦点交回编辑器)
  await window.locator('text=src').first().click();
  await expect
    .poll(() => window.evaluate(() => document.activeElement?.closest('.cm-editor') === null))
    .toBe(true);
  await window.keyboard.press('ControlOrMeta+s');

  const aPath = path.join(workspaceRoot, 'src/a.ts');
  await expect
    .poll(() => readFile(aPath, 'utf8'), { timeout: 5_000 })
    .toContain('// saved-from-explorer');
});
