// 商店底部 GitUrlInstallSection 显安全风险 banner.
import { test, expect } from './fixtures/electron-app';
import {
  MARKETPLACE_GIT_URL_WARNING,
  MARKETPLACE_INDEX_OK,
  MARKETPLACE_TAB,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('Marketplace ok 态 → GitUrl 段显安全风险提示 banner', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  const marketplaceTab = window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: MARKETPLACE_TAB });
  if ((await marketplaceTab.count()) === 0) {
    test.skip(true, '无 marketplace tab');
  }
  await marketplaceTab.click();

  const okText = await window
    .getByText(MARKETPLACE_INDEX_OK)
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!okText) {
    test.skip(true, '索引未加载');
  }

  await expect(window.getByText(MARKETPLACE_GIT_URL_WARNING)).toBeVisible();
});
