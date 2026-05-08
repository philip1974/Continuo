// Settings panel reopen 后,搜索 query 重置(local state on remount).
import { test, expect } from './fixtures/electron-app';

test('搜索 → 关 panel → 重开 → query 为空', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  const search = window.locator('input[placeholder*="搜索设置"]');
  await search.fill('字号');
  await expect(window.locator('text=匹配').first()).toBeVisible();

  // 关 panel
  await window.locator('button[aria-label="Close Settings"]').click();
  await window.waitForTimeout(400);

  // 重开
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  const search2 = window.locator('input[placeholder*="搜索设置"]');
  await expect(search2).toHaveValue('');
});
