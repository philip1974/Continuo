// Settings 搜索 setting id 片段 'editor.font' → editor.fontSize 匹配.
import { test, expect } from './fixtures/electron-app';

test('搜索 editor.font → editor.fontSize 匹配', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  const search = window.locator('input[placeholder*="搜索设置"]');
  await search.fill('editor.font');

  // 主区域含 chip 'editor.fontSize'
  const chip = window
    .locator('main code')
    .filter({ hasText: 'editor.fontSize' });
  await expect(chip).toBeVisible({ timeout: 5_000 });

  // 不含 terminal.fontSize(id 片段精确)
  const tChip = window
    .locator('main code')
    .filter({ hasText: 'terminal.fontSize' });
  expect(await tChip.count()).toBe(0);
});
