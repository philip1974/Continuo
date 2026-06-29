// 改 fontSize=22 → reset → input value 回到 default 13.
import { test, expect } from './fixtures/electron-app';
import {
  clickFirstVisibleResetDefault,
  EDITOR_TAB,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('改 fontSize=22 → reset → input value=13', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  const fontInput = window.locator('input[type=number]').first();
  await fontInput.fill('22');
  await expect(fontInput).toHaveValue('22');

  // 点 visible reset
  await clickFirstVisibleResetDefault(window);

  await expect(fontInput).toHaveValue('13');
});
