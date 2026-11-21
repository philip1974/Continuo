// Settings panel reopen 后,搜索 query 重置(local state on remount).
import { test, expect } from './fixtures/electron-app';
import {
  CLOSE_SETTINGS,
  MATCHED_SETTINGS,
  openSettings,
  settingsSearch,
} from './helpers/settings';

test('搜索 → 关 panel → 重开 → query 为空', async ({ window }) => {
  await openSettings(window);

  const search = settingsSearch(window);
  await search.fill('fontSize');
  await expect(window.getByText(MATCHED_SETTINGS)).toBeVisible();

  // 关 panel
  await window.getByRole('button', { name: CLOSE_SETTINGS }).click();
  await window.waitForTimeout(400);

  // 重开
  await openSettings(window);

  const search2 = settingsSearch(window);
  await expect(search2).toHaveValue('');
});
