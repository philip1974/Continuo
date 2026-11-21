// fresh state → reset 按钮 class 含 invisible(布局保留但不响应).
import { test, expect } from './fixtures/electron-app';
import {
  EDITOR_TAB,
  resetDefaultButtons,
  SETTINGS,
  SETTINGS_NAV,
  visibleResetDefaultCount,
} from './helpers/settings';

test('编辑器 tab 默认 → 所有 reset 按钮含 invisible class', async ({
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

  // 所有 reset 按钮都应 invisible(默认未 override)
  await expect(resetDefaultButtons(window).first()).toBeAttached();
  const allInvisible = (await visibleResetDefaultCount(window)) === 0;
  expect(allInvisible).toBe(true);
});
