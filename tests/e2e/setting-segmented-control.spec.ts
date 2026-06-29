// terminal.cursorStyle select 用 SegmentedControl,3 选项:块 / 下划线 / 竖线.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS, SETTINGS_NAV, TERMINAL_TAB } from './helpers/settings';

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
  await expect(main).toContainText('光标样式');

  // 三选项
  const blockBtn = main
    .locator('button')
    .filter({ hasText: /^块$/ })
    .first();
  const underlineBtn = main
    .locator('button')
    .filter({ hasText: /^下划线$/ })
    .first();
  const barBtn = main
    .locator('button')
    .filter({ hasText: /^竖线$/ })
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
