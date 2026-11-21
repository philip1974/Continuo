// 改非主题设置(fontSize)+ 切 light → fontSize 仍是修改后值.
import { test, expect } from './fixtures/electron-app';
import {
  EDITOR_TAB,
  GENERAL_TAB,
  LIGHT_THEME,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('改 fontSize=18 + 切 light → fontSize 仍 18', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await nav.getByRole('button', { name: EDITOR_TAB }).click();

  await window.locator('input[type=number]').first().fill('18');

  // 切 light
  await nav.getByRole('button', { name: GENERAL_TAB }).click();
  await window
    .locator('button, [role=tab]')
    .filter({ hasText: LIGHT_THEME })
    .first()
    .click();
  await expect(window.locator('html')).not.toHaveClass(/dark/);

  // 回编辑器 tab → fontSize 仍 18
  await nav.getByRole('button', { name: EDITOR_TAB }).click();
  await expect(window.locator('input[type=number]').first()).toHaveValue('18');
});
