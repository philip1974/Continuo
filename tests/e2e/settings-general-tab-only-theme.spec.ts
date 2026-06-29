// 通用 tab 仅 1 个 setting:general.theme.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('通用 tab 仅 general.theme(主题)', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  // 默认 active 即「通用」

  const main = window.locator('main');
  // chip 唯一 = general.theme
  const chips = main.locator('code');
  expect(await chips.count()).toBe(1);
  await expect(chips.first()).toContainText('general.theme');
  // 标题
  await expect(main).toContainText('主题');
});
