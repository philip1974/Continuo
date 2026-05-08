// fresh state → reset 按钮 class 含 invisible(布局保留但不响应).
import { test, expect } from './fixtures/electron-app';

test('编辑器 tab 默认 → 所有 reset 按钮含 invisible class', async ({
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

  // 所有 reset 按钮都应 invisible(默认未 override)
  const allInvisible = await window.evaluate(() => {
    const btns = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="恢复默认"]',
      ),
    );
    return btns.length > 0 && btns.every((b) =>
      b.className.includes('invisible'),
    );
  });
  expect(allInvisible).toBe(true);
});
