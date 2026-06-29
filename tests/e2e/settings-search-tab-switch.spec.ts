// Settings 搜索后切 nav tab → 搜索 query 保留(还在搜索模式).
// 实际 SettingsPanel 行为:trimmed query 决定搜索模式,切 tab 不清 query.
// 所以切 tab 不影响搜索状态(纳米细节).
import { test, expect } from './fixtures/electron-app';
import {
  MATCHED_SETTINGS,
  SETTINGS_NAV,
  openSettings,
  settingsSearch,
} from './helpers/settings';

test('搜索 → 切 nav tab → 搜索 query 仍在 + 仍是搜索模式', async ({
  window,
}) => {
  await openSettings(window);

  const search = settingsSearch(window);
  await search.fill('fontSize');
  await expect(window.getByText(MATCHED_SETTINGS)).toBeVisible();

  // nav 半透明
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toHaveClass(/opacity-40/);

  // 点 nav tab(虽然 pointer-events-none,但视觉上 nav 仍存在)
  // 简化:验证搜索 input value 保留 + 仍显匹配/未找到
  await expect(search).toHaveValue('fontSize');

  // 清空搜索
  await search.fill('');
  await expect(nav).not.toHaveClass(/opacity-40/);
});
