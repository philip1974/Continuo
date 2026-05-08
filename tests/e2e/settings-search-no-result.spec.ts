// Settings 搜索完全不匹配的关键词 → 显「未找到匹配 ...」.
import { test, expect } from './fixtures/electron-app';

test('搜索 zzzzz_no_match → 主区显「未找到匹配」', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  const search = window.locator('input[placeholder*="搜索设置"]');
  await search.fill('zzzzz_no_match_xyz');
  await expect(
    window.locator('text=/未找到匹配「zzzzz_no_match_xyz」/'),
  ).toBeVisible({ timeout: 5_000 });
});
