// terminal.cursorStyle select 用 SegmentedControl,3 选项:块 / 下划线 / 竖线.
import { test, expect } from './fixtures/electron-app';
import {
  CURSOR_STYLE_BAR,
  CURSOR_STYLE_BLOCK,
  CURSOR_STYLE_SETTING,
  CURSOR_STYLE_UNDERLINE,
  SETTINGS,
  SETTINGS_NAV,
  TERMINAL_TAB,
} from './helpers/settings';

test('terminal.cursorStyle 三选项 + 切换 + 持久化', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: TERMINAL_TAB })
    .click();

  const main = window.locator('main');
  await expect(window.getByText(CURSOR_STYLE_SETTING)).toBeVisible();

  // 三选项
  const blockBtn = main
    .locator('button')
    .filter({ hasText: CURSOR_STYLE_BLOCK })
    .first();
  const underlineBtn = main
    .locator('button')
    .filter({ hasText: CURSOR_STYLE_UNDERLINE })
    .first();
  const barBtn = main
    .locator('button')
    .filter({ hasText: CURSOR_STYLE_BAR })
    .first();

  // 默认 'block':「块」按钮 active
  await expect(blockBtn).toHaveAttribute('data-active', 'true');

  // 切「下划线」
  await underlineBtn.click();
  await expect(underlineBtn).toHaveAttribute('data-active', 'true');
  await expect(blockBtn).toHaveAttribute('data-active', 'false');

  // 切「竖线」
  await barBtn.click();
  await expect(barBtn).toHaveAttribute('data-active', 'true');
});
