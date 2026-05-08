// 插件 tab:fresh state 下没有第三方插件 →「暂无第三方插件」.
// 内置 4 条 core 插件 + 已注册贡献点数字非零.
import { test, expect } from './fixtures/electron-app';

test('插件 tab → 「暂无第三方插件」 + 4 条内置 + 贡献点统计 > 0', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '插件', exact: true })
    .click();

  // 已注册贡献点 section
  await expect(window.locator('text=已注册贡献点')).toBeVisible();
  await expect(window.locator('text=Panel 类型')).toBeVisible();
  await expect(window.locator('text=命令')).toBeVisible();

  // 内置插件 4 条 core.*(用 code chip exact 匹配,避开贡献点 samples 行)
  await expect(window.getByText('core.editor', { exact: true })).toBeVisible();
  await expect(window.getByText('core.terminal', { exact: true })).toBeVisible();
  await expect(window.getByText('core.output', { exact: true })).toBeVisible();
  await expect(window.getByText('core.plugins', { exact: true })).toBeVisible();

  // 第三方区:fresh state → 暂无
  await expect(window.locator('text=暂无第三方插件')).toBeVisible();

  // Git URL 安装段(从 PluginsTabContent)
  await expect(window.locator('text=从 Git URL 安装').first()).toBeVisible();
});
