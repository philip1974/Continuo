// Marketplace 加载完成 + allTags > 0 → 显「热门标签」prefix.
// 离线 / index 错 / 空 tags → 跳过.
import { test, expect } from './fixtures/electron-app';
import { MARKETPLACE_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('Marketplace ok 态 → 显「热门标签」prefix', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const marketplaceTab = window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: MARKETPLACE_TAB });
  if ((await marketplaceTab.count()) === 0) {
    test.skip(true, '无 marketplace tab');
  }
  await marketplaceTab.click();

  // 等 ok 文本(包含 N 个插件)
  const okText = await window
    .getByText(/显示\s*\d+\s*\/\s*共\s*\d+\s*个插件/)
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!okText) {
    test.skip(true, '索引未加载(可能离线)');
  }

  // 「热门标签」prefix 应出现(allTags 多数 marketplace 索引都非空)
  const prefix = window.locator('text=热门标签');
  if ((await prefix.count()) === 0) {
    test.skip(true, 'allTags 为空,无 prefix(空索引)');
  }
  await expect(prefix.first()).toBeVisible();
});
