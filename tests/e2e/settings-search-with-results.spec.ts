// Settings 搜索有结果 → 主区显「匹配 N 项」+ 至少 1 个 bucket section.
import { test, expect } from './fixtures/electron-app';
import {
  MATCHED_SETTINGS,
  openSettings,
  settingsSearch,
} from './helpers/settings';

test('搜索 fontSize → 主区显匹配摘要 + bucket section', async ({ window }) => {
  await openSettings(window);

  const search = settingsSearch(window);
  await search.fill('fontSize');

  await expect(window.getByText(MATCHED_SETTINGS)).toBeVisible({
    timeout: 5_000,
  });

  // 至少有一个 bucket h3 显示
  const buckets = window.locator('section h3');
  expect(await buckets.count()).toBeGreaterThan(0);
});
