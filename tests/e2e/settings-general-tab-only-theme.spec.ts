// 通用 tab 含 general.theme + general.language.
import { test, expect } from './fixtures/electron-app';
import {
  LANGUAGE_SETTING,
  SETTINGS,
  SETTINGS_NAV,
  THEME_SETTING,
} from './helpers/settings';

test('通用 tab 显 general.theme + general.language', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  // 默认 active 即「通用」

  const main = window.locator('main');
  // core.general + core.language-setting 各注册一个 general setting.
  const chips = main.locator('code');
  expect(await chips.count()).toBe(2);
  await expect(chips.filter({ hasText: 'general.theme' })).toBeVisible();
  await expect(chips.filter({ hasText: 'general.language' })).toBeVisible();
  // 标题
  await expect(window.getByText(THEME_SETTING)).toBeVisible();
  await expect(window.getByText(LANGUAGE_SETTING)).toBeVisible();
});
