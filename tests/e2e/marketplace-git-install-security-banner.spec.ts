// 商店底部 GitUrlInstallSection 显安全风险 banner.
import { test, expect } from './fixtures/electron-app';

test('Marketplace ok 态 → GitUrl 段显安全风险提示 banner', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  const marketplaceTab = window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '插件商店', exact: true });
  if ((await marketplaceTab.count()) === 0) {
    test.skip(true, '无 marketplace tab');
  }
  await marketplaceTab.click();

  const okText = await window
    .getByText(/显示\s*\d+\s*\/\s*共\s*\d+\s*个插件|暂无插件/)
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!okText) {
    test.skip(true, '索引未加载');
  }

  await expect(
    window.getByText(/从第三方 Git 仓库安装.*存在安全风险/),
  ).toBeVisible();
});
