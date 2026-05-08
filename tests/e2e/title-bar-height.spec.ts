// TitleBar(顶部 header)高度 36px(h-9 = 2.25rem).
import { test, expect } from './fixtures/electron-app';

test('TitleBar 高度近 36px', async ({ window }) => {
  const titleBar = window.locator('header').first();
  await expect(titleBar).toBeVisible({ timeout: 5_000 });
  const box = await titleBar.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(34);
  expect(box!.height).toBeLessThanOrEqual(38);
});
