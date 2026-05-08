// __continuoTest.setEditorContent → store update → CM 显示新内容.
import { test, expect } from './fixtures/with-workspace';

test('open a.ts → setEditorContent → CM 内容更新 + dirty 出', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await expect(cm).toContainText('export const a = 1;');

  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setEditorContent: (id: string, c: string) => void;
          getEditorActiveTabId: () => string | null;
        };
      }
    ).__continuoTest;
    const tabId = t.getEditorActiveTabId();
    if (tabId) t.setEditorContent(tabId, 'export const HOOK = 42;\n');
  });

  await expect(cm).toContainText('HOOK', { timeout: 5_000 });
  await expect(cm).toContainText('42');
  await expect(window.locator('span[aria-label="未保存修改"]')).toBeVisible();
});
