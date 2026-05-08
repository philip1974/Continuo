// .md Source mode → CodeMirror 接管 → fontSize 影响.
import { test, expect } from './fixtures/with-workspace';

test('README.md Source mode + fontSize=24 → CM 容器 24px', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();

  await window
    .locator('main')
    .locator('button')
    .filter({ hasText: /^Source$/ })
    .first()
    .click();

  // CodeMirror 出现
  await expect(window.locator('main .cm-content')).toBeVisible({
    timeout: 10_000,
  });

  // 改 fontSize
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
        __continuoTest: { setSettingValue: (id: string, v: number) => void };
      }
    ).__continuoTest;
    t.setSettingValue('editor.fontSize', 24);
  });

  await expect(async () => {
    const fs = await window.evaluate(() => {
      const cm = document.querySelector('.cm-editor');
      if (!cm || !cm.parentElement) return null;
      return cm.parentElement.style.fontSize;
    });
    expect(fs).toBe('24px');
  }).toPass({ timeout: 5_000 });
});
