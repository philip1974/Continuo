// 主题持久化:设置页切 light → 设置值 general.theme(localStorage continuo.settings.values)=light,
// 不再写旧独立键 layoutmotion.theme.mode。
import { test, expect } from './fixtures/electron-app';
import { waitForAppReady } from './helpers/app-ready';
import { LIGHT_THEME, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('切 light → 设置值 general.theme=light(唯一存储)', async ({
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
  const stored = await window.evaluate(() => ({
    theme: (JSON.parse(localStorage.getItem('continuo.settings.values') ?? '{}') as Record<string, unknown>)[
      'general.theme'
    ],
    legacy: localStorage.getItem('layoutmotion.theme.mode'),
  }));
  expect(stored).toEqual({ theme: 'light', legacy: null });
});
