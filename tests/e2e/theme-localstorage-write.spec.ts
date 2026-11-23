// ThemeProvider 持久化:setMode('light') → localStorage 'layoutmotion.theme.mode'.
import { test, expect } from './fixtures/electron-app';
import { waitForAppReady } from './helpers/app-ready';
import { LIGHT_THEME, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('切 light → localStorage layoutmotion.theme.mode=light', async ({
  window,
}) => {
  // 默认 dark
  // index.html 静态带 class="dark":先等应用就绪(ThemeProvider 已生效),默认 dark 断言才有意义
  await waitForAppReady(window);
  await expect(window.locator('html')).toHaveClass(/dark/);

  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });

  // 切 light
  await window
    .locator('button, [role=tab]')
    .filter({ hasText: LIGHT_THEME })
    .first()
    .click();
  await expect(window.locator('html')).not.toHaveClass(/dark/);

  // localStorage
  const stored = await window.evaluate(() =>
    localStorage.getItem('layoutmotion.theme.mode'),
  );
  expect(stored).toBe('light');
});
