// ThemeProvider 持久化:setMode('light') → localStorage 'layoutmotion.theme.mode'.
import { test, expect } from './fixtures/electron-app';

test('切 light → localStorage layoutmotion.theme.mode=light', async ({
  window,
}) => {
  // 默认 dark
  await expect(window.locator('html')).toHaveClass(/dark/);

  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  // 切 light
  await window
    .locator('button, [role=tab]')
    .filter({ hasText: /^Light$/i })
    .first()
    .click();
  await expect(window.locator('html')).not.toHaveClass(/dark/);

  // localStorage
  const stored = await window.evaluate(() =>
    localStorage.getItem('layoutmotion.theme.mode'),
  );
  expect(stored).toBe('light');
});
