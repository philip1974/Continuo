// 通用 tab 含 general.theme + general.language + window.restoreWindows(启动时恢复所有窗口)+ window.zoomLevel(缩放级别)
// + editor.accessibilitySupport(读屏优化).
import { test, expect } from './fixtures/electron-app';
import {
  LANGUAGE_SETTING,
  SETTINGS,
  SETTINGS_NAV,
  THEME_SETTING,
} from './helpers/settings';

test('通用 tab 显 general.theme + general.language + window.restoreWindows + window.zoomLevel + editor.accessibilitySupport', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  // 默认 active 即「通用」

  const main = window.locator('main');
  // core.general(主题 + 启动时恢复所有窗口 + 缩放级别 + 读屏优化)+ core.language-setting(语言)
  const chips = main.locator('code');
  expect(await chips.count()).toBe(5);
  await expect(chips.filter({ hasText: 'general.theme' })).toBeVisible();
  await expect(chips.filter({ hasText: 'general.language' })).toBeVisible();
  await expect(chips.filter({ hasText: 'window.restoreWindows' })).toBeVisible();
  await expect(chips.filter({ hasText: 'window.zoomLevel' })).toBeVisible();
  await expect(chips.filter({ hasText: 'editor.accessibilitySupport' })).toBeVisible();
  // 标题
  await expect(window.getByText(THEME_SETTING)).toBeVisible();
  await expect(window.getByText(LANGUAGE_SETTING)).toBeVisible();
});
