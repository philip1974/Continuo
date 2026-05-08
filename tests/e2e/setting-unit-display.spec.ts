// number setting 行右侧 unit chip(uppercase 'px' / 'ms')显示.
import { test, expect } from './fixtures/electron-app';

test('编辑器 tab → fontSize 行 unit 显「px」(uppercase)', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '编辑器', exact: true })
    .click();

  // unit chip = span.uppercase.text-fg-dim 含 'px'(实际 css uppercase 转大写)
  // 直接搜文字 'PX'(浏览器 textContent 不变,只 CSS transform)
  // 所以 toContainText 验小写 'px' 仍通过
  const main = window.locator('main');
  // unit chip 是 span class 含 uppercase 的元素
  const chip = main
    .locator('span.uppercase')
    .filter({ hasText: /^px$/i })
    .first();
  await expect(chip).toBeVisible();
});
