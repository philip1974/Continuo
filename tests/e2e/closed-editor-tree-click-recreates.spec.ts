// 关 Editor → tree 单击文件 → editor.openTab → dock 自动重建 editor panel.
import { test, expect } from './fixtures/with-workspace';

test('关 Editor → tree click README.md → Editor 自动重建', async ({
  window,
}) => {
  await window.locator('button[aria-label="Close Editor"]').click();
  await expect(
    window.locator('[data-testid="empty-state"]'),
  ).toBeVisible({ timeout: 5_000 });

  await window.locator('text=README.md').first().click();

  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });
  await expect(
    window.locator('[data-testid="empty-state"]'),
  ).toBeHidden({ timeout: 5_000 });
});
