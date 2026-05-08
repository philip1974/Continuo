// Settings 搜索「字号」 → editor.fontSize + terminal.fontSize 都匹配,N>=2.
import { test, expect } from './fixtures/electron-app';

test('搜索 字号 → 匹配 N>=2', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  const search = window.locator('input[placeholder*="搜索设置"]');
  await search.fill('字号');

  // 匹配数 >= 2
  await expect(
    window.locator('text=/匹配\\s+([2-9]|\\d{2,})\\s+项/'),
  ).toBeVisible({ timeout: 5_000 });

  // 主区域含两个 fontSize id chip
  const chips = window
    .locator('main code')
    .filter({ hasText: /\.fontSize$/ });
  expect(await chips.count()).toBeGreaterThanOrEqual(2);
});
