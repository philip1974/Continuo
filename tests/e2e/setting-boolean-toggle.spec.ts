// Boolean SettingItem 用 ToggleSwitch(role=switch) 实现.
// 切换 + reset 按钮可见性同步.
import { test, expect } from './fixtures/electron-app';
import {
  EDITOR_TAB,
  SETTINGS,
  SETTINGS_NAV,
  SHOW_LINE_NUMBERS,
  visibleResetDefaultCount,
} from './helpers/settings';

test('editor.lineNumbers 切换 → aria-checked 同步 + reset 可见', async ({
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

  // 找「显示行号」行的 toggle(aria-checked='true' 是默认)
  await expect(window.locator('main').getByText(SHOW_LINE_NUMBERS)).toBeVisible();
  // 行内的 ToggleSwitch
  const toggle = window.locator('button[role=switch]').first();
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // 切换 → false
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // reset 按钮可见(不再 invisible)
  await expect
    .poll(() => visibleResetDefaultCount(window))
    .toBeGreaterThan(0);
});
