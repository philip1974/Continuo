// ThemeProvider 持久化:setMode('light') → localStorage 'layoutmotion.theme.mode'.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('切 light → localStorage layoutmotion.theme.mode=light', async ({
  window,
}) => {
  // 默认 dark
  await expect(window.locator('html')).toHaveClass(/dark/);

  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
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
