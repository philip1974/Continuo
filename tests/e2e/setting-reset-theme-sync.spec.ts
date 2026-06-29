// general.theme = light → reset → 默认 dark → html.dark 重加.
import { test, expect } from './fixtures/electron-app';
import {
  clickFirstVisibleResetDefault,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('改 theme=light → reset → html 重新加 .dark', async ({ window }) => {
  // 默认 dark
  await expect(window.locator('html')).toHaveClass(/dark/);

  // 切到 light
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  const lightBtn = window
    .locator('button, [role=tab]')
    .filter({ hasText: /^Light$/i });
  await lightBtn.first().click();
  await expect(window.locator('html')).not.toHaveClass(/dark/, {
    timeout: 5_000,
  });

  // 同行 reset 按钮(此时 visible because override default)
  await clickFirstVisibleResetDefault(window);

  // theme 回 dark
  await expect(window.locator('html')).toHaveClass(/dark/, { timeout: 5_000 });
});
