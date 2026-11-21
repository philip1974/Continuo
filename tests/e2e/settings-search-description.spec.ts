// Settings 搜索 description 中的关键字 → 匹配命中.
import { test, expect } from './fixtures/electron-app';
import {
  MATCHED_SETTINGS,
  openSettings,
  settingsSearch,
} from './helpers/settings';

test('搜索 xterm → terminal.fontSize 匹配(description 含 xterm)', async ({
  window,
}) => {
  await openSettings(window);

  const search = settingsSearch(window);
  await search.fill('xterm');

  // 主区域显「匹配 N 项」+ 含 fontSize chip
  await expect(window.getByText(MATCHED_SETTINGS)).toBeVisible({
    timeout: 5_000,
  });
  await expect(
    window.locator('main code').filter({ hasText: 'terminal.fontSize' }),
  ).toBeVisible();
});
