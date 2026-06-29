// 切到 light 主题后 shell 关键元素仍正常渲染.
import { test, expect } from './fixtures/electron-app';
import {
  CLOSE_SETTINGS,
  LIGHT_THEME,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('light 主题下:TitleBar / IconSidebar / StatusBar 都可见', async ({
  window,
}) => {
  // 默认 dark
  await expect(window.locator('html')).toHaveClass(/dark/);

  // 切 light 通过 SettingsPanel
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('button, [role=tab]')
    .filter({ hasText: LIGHT_THEME })
    .first()
    .click();
  await expect(window.locator('html')).not.toHaveClass(/dark/);

  // 关 settings 后基础元素仍渲染
  await window.getByRole('button', { name: CLOSE_SETTINGS }).click();
  await window.waitForTimeout(300);

  await expect(window.locator('header').first()).toBeVisible();
  await expect(window.locator('main aside').first()).toBeVisible();
  await expect(window.locator('footer')).toBeVisible();

  // Settings 齿轮按钮仍可点
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
});
