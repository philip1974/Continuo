// 商店 SettingTab:loading / error / 列表渲染.
//
// 该 tab 启动时调 fetchMarketplaceIndex(GitHub raw),离线 / 网络受限时会 error.
// 我们只验证 tab 可点开,UI 处于三个有效态之一(loading / ok / error).
import { test, expect } from './fixtures/electron-app';

test('商店 tab 可打开 + UI 是三态之一', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  // 内置 tab id='marketplace' 标题「插件商店」(详见 PluginsTabPlugin)
  const marketplaceTab = window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '插件商店', exact: true });
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
    .getByText(/显示\s*\d+\s*\/\s*共\s*\d+\s*个插件|暂无插件|拉取索引失败/, {
      exact: false,
    })
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  expect(ok).toBe(true);
});

test('商店底部 Git URL 安装段 — 输入空 → 按钮 disabled', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  const marketplaceTab = window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '插件商店', exact: true });
  if ((await marketplaceTab.count()) === 0) {
    test.skip(true, '该构建未注册 marketplace tab');
  }
  await marketplaceTab.click();

  // 等任一稳态加载完(最多 15s)— 即使 error 态也会渲染整段(error 在中部,但 GitUrlInstall 仅 ok 才渲染).
  const okText = await window
    .getByText(/显示\s*\d+\s*\/\s*共\s*\d+\s*个插件|暂无插件/, {
      exact: false,
    })
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (!okText) {
    test.skip(true, '索引未加载成功(可能离线),跳过 Git URL 安装段断言');
  }

  await expect(window.getByText('从 Git URL 安装').first()).toBeVisible();
  const installBtn = window.getByRole('button', { name: '安装扩展' });
  await expect(installBtn).toBeDisabled();
});
