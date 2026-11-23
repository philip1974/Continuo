// 商店底部 GitUrlInstallSection 显安全风险 banner.
import { test, expect } from './fixtures/electron-app';
import {
  MARKETPLACE_GIT_URL_WARNING,
  MARKETPLACE_INDEX_NONEMPTY,
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
  // core.marketplace 由内置插件无条件注册:tab 缺失 / 改名是回归,应失败而不是跳过
  await expect(marketplaceTab).toBeVisible({ timeout: 10_000 });
  await marketplaceTab.click();

  const okText = await window
    .getByText(MARKETPLACE_INDEX_NONEMPTY)
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!okText) {
    test.skip(true, '索引未加载');
  }

  await expect(window.getByText(MARKETPLACE_GIT_URL_WARNING)).toBeVisible();
});
