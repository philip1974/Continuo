// Settings 搜索完全不匹配的关键词 → 显「未找到匹配 ...」.
import { test, expect } from './fixtures/electron-app';
import {
  NO_MATCH_SETTINGS,
  openSettings,
  settingsSearch,
} from './helpers/settings';

test('搜索 zzzzz_no_match → 主区显「未找到匹配」', async ({ window }) => {
  await openSettings(window);

  const search = settingsSearch(window);
  await search.fill('zzzzz_no_match_xyz');
  await expect(window.getByText(NO_MATCH_SETTINGS)).toBeVisible({
    timeout: 5_000,
  });
});
