// 商店 SettingTab:loading / error / 列表渲染.
//
// 该 tab 启动时调 fetchMarketplaceIndex(GitHub raw),离线 / 网络受限时会 error.
// 我们只验证 tab 可点开,UI 处于三个有效态之一(loading / ok / error).
import { test, expect } from './fixtures/electron-app';
import {
  MARKETPLACE_GIT_URL_INSTALL,
  MARKETPLACE_INDEX_NONEMPTY,
  MARKETPLACE_INSTALL_EXTENSION,
  MARKETPLACE_READY,
  MARKETPLACE_TAB,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('商店 tab 可打开 + UI 是三态之一', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });

  // 内置 tab id='marketplace' 标题「插件市场」(详见 PluginsTabPlugin)
  const marketplaceTab = window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: MARKETPLACE_TAB });
  // core.marketplace 由内置插件无条件注册:tab 缺失 / 改名是回归,应失败而不是跳过
  await expect(marketplaceTab).toBeVisible({ timeout: 10_000 });
  await marketplaceTab.click();

  // 等到 loading 完成或 error 出现:
  //   ok → 「显示 N / 共 M 个插件」or「暂无插件」or「没有匹配的插件」
  //   error → 「拉取索引失败」
  //   loading → spinner svg
  // 用 polling 直到任一稳态文本出现
  const ok = await window
    .getByText(MARKETPLACE_READY, { exact: false })
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  expect(ok).toBe(true);
});

test('商店底部 Git URL 安装段 — 输入空 → 按钮 disabled', async ({
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

  // 等索引加载成功且非空(最多 15s)— error / 空索引态会提前返回、不渲染 GitUrlInstall,此时跳过.
  const okText = await window
    .getByText(MARKETPLACE_INDEX_NONEMPTY, { exact: false })
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (!okText) {
    test.skip(true, '索引未加载成功(可能离线),跳过 Git URL 安装段断言');
  }

  await expect(
    window.getByText(MARKETPLACE_GIT_URL_INSTALL).first(),
  ).toBeVisible();
  const installBtn = window.getByRole('button', {
    name: MARKETPLACE_INSTALL_EXTENSION,
  });
  await expect(installBtn).toBeDisabled();
});
