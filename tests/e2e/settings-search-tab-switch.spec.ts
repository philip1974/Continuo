// Settings 搜索模式:nav 变暗且按钮 disabled(不能切 tab),query 保留;清空搜索后 nav 恢复可用.
import { test, expect } from './fixtures/electron-app';
import {
  MATCHED_SETTINGS,
  SETTINGS_NAV,
  openSettings,
  settingsSearch,
} from './helpers/settings';

test('搜索 → nav 禁用(不能切 tab)+ query 保留 → 清空后 nav 恢复', async ({
  window,
}) => {
  await openSettings(window);

  const search = settingsSearch(window);
  await search.fill('fontSize');
  await expect(window.getByText(MATCHED_SETTINGS)).toBeVisible();

  // nav 半透明
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toHaveClass(/opacity-40/);

  // 搜索模式下 nav 按钮 disabled(鼠标与键盘都不能切 tab),query 保留
  const navButtons = nav.getByRole('button');
  await expect(navButtons.first()).toBeDisabled();
  await expect(search).toHaveValue('fontSize');

  // 清空搜索 → nav 恢复
  await search.fill('');
  await expect(nav).not.toHaveClass(/opacity-40/);
  await expect(navButtons.first()).toBeEnabled();
});
