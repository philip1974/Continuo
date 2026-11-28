// 主题持久化:设置页切 light → 设置值 general.theme(主进程文件 user-settings.json)=light,
// 不再写旧独立键 layoutmotion.theme.mode。
import { test, expect } from './fixtures/electron-app';
import { readUserSettingsFile } from './helpers/user-settings-file';
import { waitForAppReady } from './helpers/app-ready';
import { LIGHT_THEME, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('切 light → 设置值 general.theme=light(唯一存储)', async ({
  window,
  userDataDir,
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

  await expect.poll(() => readUserSettingsFile(userDataDir)?.['general.theme']).toBe('light');
  expect(await window.evaluate(() => localStorage.getItem('layoutmotion.theme.mode'))).toBeNull();
});
