// Settings 搜索有结果 → 主区显「匹配 N 项」+ 至少 1 个 bucket section.
import { test, expect } from './fixtures/electron-app';
import {
  EDITOR_TAB,
  MATCHED_SETTINGS,
  TERMINAL_TAB,
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

  // 搜索结果按分类分组:fontSize 同时命中编辑器与终端两个分类(非搜索视图只显示单个 tab,不会同时出现)
  const buckets = window.locator('main section h3');
  await expect(buckets.filter({ hasText: EDITOR_TAB })).toHaveCount(1);
  await expect(buckets.filter({ hasText: TERMINAL_TAB })).toHaveCount(1);
});
