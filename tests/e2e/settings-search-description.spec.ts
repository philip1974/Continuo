// Settings 搜索 description 中的关键字 → 匹配命中.
import { test, expect } from './fixtures/electron-app';

test('搜索 CodeEditor → editor.fontSize 匹配(description 含 CodeEditor)', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  const search = window.locator('input[placeholder*="搜索设置"]');
  await search.fill('CodeEditor');

  // 主区域显「匹配 N 项」+ 含 fontSize chip
  await expect(
    window.locator('text=/匹配\\s+\\d+\\s+项/'),
  ).toBeVisible({ timeout: 5_000 });
  await expect(
    window.locator('main code').filter({ hasText: 'editor.fontSize' }),
  ).toBeVisible();
});
