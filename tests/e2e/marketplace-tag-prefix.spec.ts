// Marketplace 加载完成 + allTags > 0 → 显「热门标签」prefix.
// 离线 / 索引加载失败或为空 → 跳过;索引非空时无条件断言标签行.
import { test, expect } from './fixtures/electron-app';
import {
  MARKETPLACE_INDEX_NONEMPTY,
  MARKETPLACE_POPULAR_TAGS,
  MARKETPLACE_TAB,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('Marketplace ok 态 → 显「热门标签」prefix', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  // 先等设置导航渲染,否则下面立即取值的 count() 会在渲染前得到 0 而误跳过
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

  // 等索引加载成功且非空(空索引不渲染标签行)
  const okText = await window
    .getByText(MARKETPLACE_INDEX_NONEMPTY)
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!okText) {
    test.skip(true, '索引未加载(可能离线)');
  }

  // 「热门标签」prefix 应出现(正式索引条目都带 tags)
  await expect(window.getByText(MARKETPLACE_POPULAR_TAGS).first()).toBeVisible();
});
