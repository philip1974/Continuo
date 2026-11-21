// Theme 切换:Settings → 通用 → general.theme select.
// 从 dark 切到 light → html.dark 移除;切回 → 加上.
import { test, expect } from './fixtures/electron-app';
import {
  DARK_THEME,
  LIGHT_THEME,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('通用 → 主题切到 light → html.dark 移除', async ({ window }) => {
  // 默认 dark:html 上有 .dark
  await expect(window.locator('html')).toHaveClass(/dark/);

  // 打开 Settings,留在「通用」tab(默认首项)
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });

  // 找到 general.theme 行的 SegmentedControl,点 light option
  const lightBtn = window
    .locator('button, [role=tab]')
    .filter({ hasText: LIGHT_THEME });
  await expect(lightBtn.first()).toBeVisible();
  await lightBtn.first().click();

  await expect(window.locator('html')).not.toHaveClass(/dark/);

  // 切回默认暗色
  const darkBtn = window
    .locator('button, [role=tab]')
    .filter({ hasText: DARK_THEME });
  await darkBtn.first().click();
  await expect(window.locator('html')).toHaveClass(/dark/);
});
