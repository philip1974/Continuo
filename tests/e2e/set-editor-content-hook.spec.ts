// __continuoTest.setEditorContent → store update → CM 显示新内容.
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_UNSAVED_CHANGES_SELECTOR } from './helpers/editor';
import { waitForTestHooks } from './helpers/app-ready';

test('open a.ts → setEditorContent → CM 内容更新 + dirty 出', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await expect(cm).toContainText('export const a = 1;');

  await waitForTestHooks(window);

  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    const tabId = t.getEditorActiveTabId();
    if (tabId) t.setEditorContent(tabId, 'export const HOOK = 42;\n');
  });

  await expect(cm).toContainText('HOOK', { timeout: 5_000 });
  await expect(cm).toContainText('42');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible();
});
