// terminal.cursorStyle select 用 SegmentedControl,3 选项:块 / 下划线 / 竖线.
import { test, expect } from './fixtures/electron-app';

test('terminal.cursorStyle 三选项 + 切换 + 持久化', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '终端', exact: true })
    .click();

  const main = window.locator('main');
  await expect(main).toContainText('光标样式');

  // 三选项
  const blockBtn = main
    .locator('button')
    .filter({ hasText: /^块$/ })
    .first();
  const underlineBtn = main
    .locator('button')
    .filter({ hasText: /^下划线$/ })
    .first();
  const barBtn = main
    .locator('button')
    .filter({ hasText: /^竖线$/ })
    .first();

  // 默认 'block':「块」按钮 active
  await expect(blockBtn).toHaveAttribute('data-active', 'true');

  // 切「下划线」
  await underlineBtn.click();
  await expect(underlineBtn).toHaveAttribute('data-active', 'true');
  await expect(blockBtn).toHaveAttribute('data-active', 'false');

  // 切「竖线」
  await barBtn.click();
  await expect(barBtn).toHaveAttribute('data-active', 'true');
});
