// Settings 搜索有结果 → 主区显「匹配 N 项」+ 至少 1 个 bucket section.
import { test, expect } from './fixtures/electron-app';

test('搜索 字号 → 主区显「匹配 N 项」+ bucket section', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  const search = window.locator('input[placeholder*="搜索设置"]');
  await search.fill('字号');

  await expect(
    window.locator('text=/匹配\\s+\\d+\\s+项「字号」/'),
  ).toBeVisible({ timeout: 5_000 });

  // 至少有一个 bucket h3 显示
  const buckets = window.locator('section h3');
  expect(await buckets.count()).toBeGreaterThan(0);
});
