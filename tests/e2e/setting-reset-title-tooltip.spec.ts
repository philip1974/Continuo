// SettingItemRow reset 按钮 title 含「恢复默认(${default})」.
import { test, expect } from './fixtures/electron-app';
import {
  EDITOR_TAB,
  RESET_DEFAULT_TEXT,
  resetDefaultButtons,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('改 fontSize → reset 按钮 title 含 default 值', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  // 改 fontSize 触发 override
  const fontInput = window.locator('input[type=number]').first();
  await fontInput.fill('15');

  // reset 按钮 title 含 'editor.fontSize 默认值 13'(默认值会出现在 title)
  // 实际 title 是 `恢复默认(${spec.default})`,所以含数字 13
  const resetBtn = resetDefaultButtons(window).first();
  const t = await resetBtn.getAttribute('title');
  expect(t ?? '').toMatch(RESET_DEFAULT_TEXT);
  expect(t).toContain('13');
});
