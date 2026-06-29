// 通用 tab 主题 SegmentedControl 三选项 + 默认 Dark active.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('Settings 通用 → 主题 Light/Dark/System + 默认 Dark active', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });
  // 默认就是「通用」 tab

  const main = window.locator('main');
  const lightBtn = main
    .locator('button')
    .filter({ hasText: /^Light$/i })
    .first();
  const darkBtn = main
    .locator('button')
    .filter({ hasText: /^Dark$/i })
    .first();
  const systemBtn = main
    .locator('button')
    .filter({ hasText: /^System$/i })
    .first();

  await expect(lightBtn).toBeVisible();
  await expect(darkBtn).toBeVisible();
  await expect(systemBtn).toBeVisible();

  // 默认 Dark active
  await expect(darkBtn).toHaveAttribute('data-active', 'true');
  await expect(lightBtn).toHaveAttribute('data-active', 'false');
  await expect(systemBtn).toHaveAttribute('data-active', 'false');
});
