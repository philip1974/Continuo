// Settings 顶部搜索框 autoFocus(打开 panel 时焦点到 input).
import { test, expect } from './fixtures/electron-app';

test('打开 Settings → 搜索框 autofocus', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });

  // active element 是搜索 input(autoFocus)
  const focused = await window.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null;
    return el?.placeholder ?? null;
  });
  expect(focused).toContain('搜索设置');
});
