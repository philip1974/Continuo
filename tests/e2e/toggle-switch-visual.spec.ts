// ToggleSwitch checked=true → class 含 bg-accent;false → bg-panel-soft.
import { test, expect } from './fixtures/electron-app';
import { EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('显示行号 toggle: 默认 bg-accent → 切 false → bg-panel-soft', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  const toggle = window.locator('button[role=switch]').first();
  await expect(toggle).toHaveClass(/bg-accent/);

  await toggle.click();
  await expect(toggle).toHaveClass(/bg-panel-soft/, { timeout: 3_000 });
  await expect(toggle).not.toHaveClass(/bg-accent/);
});
