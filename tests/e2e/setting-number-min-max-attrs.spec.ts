// editor.fontSize input min=10/max=28/step=1 → DOM 属性.
import { test, expect } from './fixtures/electron-app';
import { EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('editor.fontSize input min/max/step 属性渲染', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await nav.getByRole('button', { name: EDITOR_TAB }).click();

  const input = window.locator('input[type=number]').first();
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute('min', '10');
  await expect(input).toHaveAttribute('max', '28');
  await expect(input).toHaveAttribute('step', '1');
});
