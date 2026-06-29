// Settings 搜索「字号」 → editor.fontSize + terminal.fontSize 都匹配,N>=2.
import { test, expect } from './fixtures/electron-app';
import {
  MATCHED_SETTINGS,
  openSettings,
  settingsSearch,
} from './helpers/settings';

test('搜索 fontSize → 匹配 N>=2', async ({ window }) => {
  await openSettings(window);

  const search = settingsSearch(window);
  await search.fill('fontSize');

  // 匹配数 >= 2
  await expect(window.getByText(MATCHED_SETTINGS)).toBeVisible({
    timeout: 5_000,
  });

  // 主区域含两个 fontSize id chip
  const chips = window
    .locator('main code')
    .filter({ hasText: /\.fontSize$/ });
  expect(await chips.count()).toBeGreaterThanOrEqual(2);
});
