// 商店 SettingTab:loading / error / 列表渲染.
//
// 该 tab 启动时调 fetchMarketplaceIndex(GitHub raw),离线 / 网络受限时会 error.
// 我们只验证 tab 可点开,UI 处于三个有效态之一(loading / ok / error).
import { test, expect } from './fixtures/electron-app';
import {
  MARKETPLACE_GIT_URL_INSTALL,
  MARKETPLACE_INDEX_OK,
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

  // 内置 tab id='marketplace' 标题「插件商店」(详见 PluginsTabPlugin)
  const marketplaceTab = window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: MARKETPLACE_TAB });
  if ((await marketplaceTab.count()) === 0) {
    test.skip(true, '该构建未注册 marketplace tab');
  }
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
  if ((await marketplaceTab.count()) === 0) {
    test.skip(true, '该构建未注册 marketplace tab');
  }
  await marketplaceTab.click();

  // 等任一稳态加载完(最多 15s)— 即使 error 态也会渲染整段(error 在中部,但 GitUrlInstall 仅 ok 才渲染).
  const okText = await window
    .getByText(MARKETPLACE_INDEX_OK, { exact: false })
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
