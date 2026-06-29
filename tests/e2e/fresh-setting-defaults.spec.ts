// fresh userData → settings input 显示 spec.default(13 / true 等).
import { test, expect } from './fixtures/electron-app';
import { EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('打开 Settings 编辑器 → fontSize input value=13(默认)', async ({
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

  // editor.fontSize default=13
  await expect(window.locator('input[type=number]').first()).toHaveValue('13');
  // editor.lineNumbers default=true
  const lineNumbers = window.locator('button[role=switch]').first();
  await expect(lineNumbers).toHaveAttribute('aria-checked', 'true');
});
