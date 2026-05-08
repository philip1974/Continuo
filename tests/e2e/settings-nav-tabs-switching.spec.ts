// Settings 内多 nav tab 切换 → 内容区随之切换.
import { test, expect } from './fixtures/electron-app';

test('依次切「通用 → 编辑器 → 资源管理器 → 终端 → 快捷键 → 插件」内容均渲染', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  const nav = window.locator('nav[aria-label="设置分类"]');
  await expect(nav).toBeVisible({ timeout: 10_000 });

  const main = window.locator('main');

  // 通用(默认 active 含主题 / 字号配置)
  await nav.getByRole('button', { name: '通用', exact: true }).click();
  await expect(main).toContainText('主题');

  await nav.getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(main).toContainText('字号');

  await nav.getByRole('button', { name: '终端', exact: true }).click();
  await expect(main).toContainText('光标样式');

  await nav.getByRole('button', { name: '快捷键', exact: true }).click();
  await expect(main).toContainText('共');

  await nav.getByRole('button', { name: '插件', exact: true }).click();
  await expect(main).toContainText('已注册贡献点');
});
